"use strict";
/* ============ 用户自建插件带来的画布节点（声明式 · 动态注册） ============
 *
 * 背景：画布节点 kind 一直是硬编码的 —— 渲染/图标/配色/端子/右键菜单/执行分派各有一处
 * 真源（见 KIND_CLS / KIND_ICON_SVG / NODE_DEFAULTS / IN_PORT_DATA_KINDS / KIND_TAGS /
 * canvasCreateMenuGroups / playNodeBody）。用户插件要带来新节点，就必须有一套**运行时**
 * 的 kind 注册：本文件把这些真源统一成一个装饰表 REG，并在下列位置各加一个「先问注册表」
 * 的入口（都只多一行，不搬动任何既有分支）：
 *   · app.js   NODE_DEFAULTS / KIND_CLS / KIND_ICON_SVG / KIND_TAGS / inputCount /
 *              outputCount / inPortKindOf / hasFixedInPorts / nodeKindLabel /
 *              valueForInput / canvasCreateMenuGroups / assignDefaultProvider
 *   · app-canvas.js  buildBody（插件节点 = 插件名 + 参数 + 状态行）
 *   · app-nodes.js   playNodeBody（分派给本文件的 runPluginNode）
 *
 * 安全与兼容口径（与用户共识一致）：插件只声明 JSON，不允许任何自定义 JS。
 * 本文件执行插件节点时只用两条既有通路 —— 模型类走 apiCallTextStream（节点自带的
 * providerId / model），HTTP 类走主进程的通用本机 HTTP IPC（渲染层不直连 127.0.0.1）。
 */

/* kind → 插件节点定义（含 call；菜单/渲染只需要装饰字段，执行时用 deep 版） */
let PLUGIN_NODES = Object.create(null);
let PLUGIN_LIST = [];
let PLUGIN_NODES_LOADED = false;
let PLUGIN_NODES_LOADING = null;

const PLUGIN_NODE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 2.4h3.6a1 1 0 0 1 1 1v1.1h1.1a1 1 0 0 1 1 1v3.6a1 1 0 0 1-1 1H9.7v1.1a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1v-3.6a1 1 0 0 1 1-1H5.5V3.4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M10.9 6.2h2.6M10.9 8.8h2.6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" opacity=".7"/></svg>';

/* 插件的配色族：统一用 .wf-node.up（css 里一条规则），与内置各族一眼可分 */
const PLUGIN_KIND_CLS = "up";

/* 查插件节点定义：**既能收节点对象，也能收 kind 字符串** —— 调用点两种写法都有
   （app.js 的端子函数传 node，本文件的执行路径传 node.kind）。
   绝不能写 `String(kind)`：节点对象转字符串是 "[object Object]"，查表必然落空，
   插件节点会被当成「未注册」（端子、body、执行三处同时失效）。 */
function pluginKindOf(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return typeof v.kind === "string" ? v.kind : "";
  return "";
}
function pluginNodeDef(kind) {
  const k = pluginKindOf(kind);
  return (k && PLUGIN_NODES[k]) || null;
}
function isPluginKind(node) {
  return !!pluginNodeDef(node);
}
function pluginNodeDefs() {
  return Object.keys(PLUGIN_NODES).map((k) => PLUGIN_NODES[k]);
}
function pluginNodesOf(pluginId) {
  return pluginNodeDefs().filter((d) => d.pluginId === String(pluginId || ""));
}
function pluginLabelOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v.zh || v.en || "");
  return String(v);
}

/* ── 把定义挂进应用既有的那些真源（只加键，不改既有条目） ── */
function applyPluginKindTables() {
  if (typeof NODE_DEFAULTS !== "object" || !NODE_DEFAULTS) return;
  for (const d of pluginNodeDefs()) {
    const inputs = d.inputs || [];
    const outputs = d.outputs || [];
    const params = d.params || [];
    const def = {
      w: d.w || 260,
      h: d.h || 190,
      title: pluginLabelOf(d.title) || d.id,
      _pluginNode: true,
      _pluginId: d.pluginId,
      _pluginNote: pluginLabelOf(d.desc),
      _pluginCallKind: (d.call && d.call.kind) || "http",
      pluginParams: {},
      outputPaths: {},
      outputText: "",
      pluginStatus: "",
    };
    for (const p of params) def.pluginParams[p.id] = p.def;
    if (def._pluginCallKind === "model") {
      /* 模型类节点：与 proc_text 同口径，创建时由 assignDefaultProvider 补服务商与模型 */
      def.providerId = "";
      def.model = "";
      def.temperature = 0.7;
      def.effort = "high";
    }
    for (const o of outputs) def.outputPaths[o.id] = "";
    NODE_DEFAULTS[d.kind] = def;
    KIND_CLS[d.kind] = PLUGIN_KIND_CLS;
    KIND_ICON_SVG[d.kind] = PLUGIN_NODE_SVG;
    if (typeof KIND_TAGS === "object" && KIND_TAGS) KIND_TAGS[d.kind] = "插件";
    if (typeof IN_PORT_DATA_KINDS === "object" && IN_PORT_DATA_KINDS) {
      /* 端口级类型声明：控制语义一律不声明（插件节点只有数据端子 + 末位控制出），
         取值与既有固定端子节点同口径 —— 声明了就按声明校验连线 */
      IN_PORT_DATA_KINDS[d.kind] = inputs.map((p) => p.kind);
    }
    registerPluginNodeSettings(d);
  }
  if (!applyPluginKindTables._sideCat) {
    applyPluginKindTables._sideCat = ["插件节点", []];
    SIDE_CATS.push(applyPluginKindTables._sideCat);
  }
  applyPluginKindTables._sideCat[1] = pluginNodeDefs().map((d) => d.kind);
}

/* ── 参数面板：插件节点自己声明了参数，就在 ⚙ 跳窗里按声明生成控件 ── */
function registerPluginNodeSettings(def) {
  if (typeof registerNodeSettingsForm !== "function") return;
  registerNodeSettingsForm(def.kind, {
    gearTitle: () =>
      (def.call && def.call.kind) === "model" ? I18n.t("服务商 / 模型 / 参数") : I18n.t("参数"),
    summary: (node) =>
      typeof nsApiSummary === "function" && (def.call && def.call.kind) === "model"
        ? nsApiSummary(node)
        : "",
    build: (ctx) => {
      const node = ctx.node;
      if ((def.call && def.call.kind) === "model") {
        if (typeof nsProviderModelFields === "function") nsProviderModelFields(ctx, node);
        if (typeof nsTemperatureField === "function") nsTemperatureField(ctx, node);
      }
      for (const p of def.params || []) {
        let el = null;
        const cur = () => {
          const bag = node.pluginParams && typeof node.pluginParams === "object" ? node.pluginParams : {};
          const v = bag[p.id];
          return v == null ? p.def : v;
        };
        const put = (v) => {
          if (!node.pluginParams || typeof node.pluginParams !== "object") node.pluginParams = {};
          node.pluginParams[p.id] = v;
          ctx.commit();
        };
        if (p.type === "select") {
          el = document.createElement("select");
          for (const o of p.options || []) {
            const op = document.createElement("option");
            op.value = o.value;
            op.textContent = pluginLabelOf(o.label) || o.value;
            el.appendChild(op);
          }
          el.value = String(cur());
          el.addEventListener("change", () => put(el.value));
        } else if (p.type === "bool") {
          el = document.createElement("input");
          el.type = "checkbox";
          el.checked = !!cur();
          el.addEventListener("change", () => put(!!el.checked));
        } else if (p.type === "number") {
          el = document.createElement("input");
          el.type = "number";
          el.value = String(cur());
          el.addEventListener("change", () => put(Number(el.value) || 0));
        } else if (p.type === "textarea") {
          el = document.createElement("textarea");
          el.className = "mini-ta";
          el.value = String(cur());
          el.placeholder = p.placeholder || "";
          el.addEventListener("change", () => put(el.value));
        } else {
          el = document.createElement("input");
          el.type = "text";
          el.value = String(cur());
          el.placeholder = p.placeholder || "";
          el.addEventListener("change", () => put(el.value));
        }
        if (el) {
          const lab = pluginLabelOf(p.label) || p.id;
          ctx.field(pluginLabelOf(p.desc) ? lab + " · " + pluginLabelOf(p.desc) : lab, el);
        }
      }
      const hint = document.createElement("div");
      hint.className = "settings-hint";
      hint.textContent = I18n.t("本节点由插件提供（声明式定义）：") +
        (def.pluginId || "") + " · " + def.kind;
      ctx.root.appendChild(hint);
    },
  });
}

/* ── 加载（启动时 await，插件对话框里也会触发重扫） ── */
function loadPluginNodes(force) {
  if (PLUGIN_NODES_LOADING && !force) return PLUGIN_NODES_LOADING;
  if (PLUGIN_NODES_LOADED && !force) return Promise.resolve(pluginNodeDefs());
  PLUGIN_NODES_LOADING = (async () => {
    let r = null;
    try {
      if (window.api && window.api.userPluginsNodes) r = await window.api.userPluginsNodes();
    } catch (e) {
      r = null;
    }
    PLUGIN_NODES = Object.create(null);
    for (const d of (r && r.nodes) || []) {
      if (d && d.kind) PLUGIN_NODES[d.kind] = d;
    }
    PLUGIN_NODES_LOADED = true;
    PLUGIN_NODES_LOADING = null;
    applyPluginKindTables();
    return pluginNodeDefs();
  })();
  return PLUGIN_NODES_LOADING;
}

/* ── 端子 ── */
function pluginInPortCount(node) {
  const d = pluginNodeDef(node);
  if (!d) return Math.max(1, allWiresTo(node.id).length + 1);
  return (d.inputs || []).length;
}
function pluginOutPortCount(node) {
  const d = pluginNodeDef(node);
  if (!d) return 1;
  /* 数据出端口 = 声明数；末位控制出端口（与函数 / 工具节点同口径：控制流能穿过去） */
  return (d.outputs || []).length + 1;
}
function pluginPortMeta(node, dir, idx) {
  const d = pluginNodeDef(node);
  if (!d) return null;
  const i = Number(idx);
  if (!isFinite(i) || i < 0) return null;
  const list = dir === "in" ? d.inputs || [] : d.outputs || [];
  return list[i] || null;
}
/** 该端口当前值（渲染层取值统一走 valueForInput，与别处同源） */
function pluginInputValue(node, portId) {
  const d = pluginNodeDef(node);
  if (!d) return "";
  const idx = (d.inputs || []).findIndex((p) => p.id === portId);
  if (idx < 0) return "";
  const port = d.inputs[idx];
  const vals = [];
  for (const it of inputValuesFor(node, idx)) {
    const v = it && it.value;
    if (!v) continue;
    if (port.kind === "image") {
      if (v.path) vals.push(String(v.path));
    } else if (v.text != null && String(v.text) !== "") {
      vals.push(String(v.text));
    }
  }
  if (port.list) return vals;
  return vals.length ? vals[0] : "";
}

/* ── 模板渲染：{input:端口id} / {inputJson:端口id} / {text} / {param:参数id} / {node:title} / {plugin:id} ── */
function pluginTemplateVars(node, def) {
  const inputs = {};
  let textAll = [];
  for (const p of def.inputs || []) {
    const v = pluginInputValue(node, p.id);
    inputs[p.id] = v;
    if (typeof v === "string" && v) textAll.push(v);
    else if (Array.isArray(v)) textAll = textAll.concat(v.filter((x) => typeof x === "string" && x));
  }
  const params = {};
  const bag = node.pluginParams && typeof node.pluginParams === "object" ? node.pluginParams : {};
  for (const p of def.params || []) params[p.id] = bag[p.id] == null ? p.def : bag[p.id];
  return { inputs, params, textAll: textAll.join("\n\n") };
}
function pluginFillTemplate(tpl, node, def) {
  const V = pluginTemplateVars(node, def);
  return String(tpl == null ? "" : tpl).replace(/\{([a-zA-Z]+):([A-Za-z0-9_]+)\}/g, (m, kind, key) => {
    if (kind === "input") {
      const v = V.inputs[key];
      if (Array.isArray(v)) return v.join("\n");
      return v == null ? "" : String(v);
    }
    if (kind === "inputJson") return JSON.stringify(V.inputs[key] == null ? "" : V.inputs[key]);
    if (kind === "param") {
      const v = V.params[key];
      if (Array.isArray(v)) return v.join(", ");
      return v == null ? "" : String(v);
    }
    if (kind === "node") return String(node.title || "");
    if (kind === "plugin") return String(def.pluginId || "");
    return m;
  }).replace(/\{text\}/g, V.textAll);
}
/** JSON 里逐字段填模板（bodyJson / headers 用），字符串叶子才替换 */
function pluginFillJson(v, node, def) {
  if (typeof v === "string") return pluginFillTemplate(v, node, def);
  if (Array.isArray(v)) return v.map((x) => pluginFillJson(x, node, def));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = pluginFillJson(val, node, def);
    return o;
  }
  return v;
}
/** 从响应 JSON 里按 "a.b.0.c" 取一个值 */
function pluginPickPath(obj, pathStr) {
  const p = String(pathStr || "").trim();
  if (!p) return undefined;
  let cur = obj;
  for (const seg of p.split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}
function pluginValueToText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/* ── 执行 ── */
async function runPluginNode(node, quiet) {
  const def = pluginNodeDef(node);
  if (!def) {
    node.error = I18n.t("插件节点未注册（插件已删除 / 停用）：") + String(node.kind || "");
    if (!quiet) toast(node.error, "warn");
    renderCanvas();
    return;
  }
  if (!node.pluginParams || typeof node.pluginParams !== "object") node.pluginParams = {};
  if (!node.outputPaths || typeof node.outputPaths !== "object") node.outputPaths = {};
  node.running = true;
  node.error = null;
  if (typeof beginNodeRun === "function") beginNodeRun(node);
  node.pluginStatus = I18n.t("处理中…");
  renderCanvas();
  const t0 = Date.now();
  try {
    if ((def.call && def.call.kind) === "model") {
      await runPluginModelNode(node, def, quiet);
    } else {
      await runPluginHttpNode(node, def, quiet);
    }
    if (node._aborted) {
      node.error = null;
      node.pluginStatus = I18n.t("已取消");
      return;
    }
    node.ranAt = Date.now();
    node.pluginStatus = I18n.t("完成 · ") + ((Date.now() - t0) / 1000).toFixed(1) + "s";
    if (!quiet) toast(I18n.t("插件节点已完成：") + (node.title || def.title.zh || ""));
  } catch (e) {
    node.error = (e && e.message) || String(e);
    node.pluginStatus = node.error;
    if (!quiet) toast(node.error, "err");
  } finally {
    node.running = false;
    node._aborted = false;
    renderCanvas();
    if (typeof scheduleSave === "function") scheduleSave();
  }
}

/** 模型类：复用 MTNode 已配好的服务商与模型（节点自带的 providerId / model） */
async function runPluginModelNode(node, def, quiet) {
  const provId = node.providerId || "";
  let prov = (S.config.providers || []).find((p) => p.id === provId) || null;
  if (!prov) {
    /* 没显式选过模型：跟随全局默认（与 proc_text 的 apiProvidersForKind 同源） */
    const first = typeof apiProvidersForKind === "function" ? apiProvidersForKind("proc_text")[0] : null;
    if (!first) throw new Error(I18n.t("未配置服务商（设置 · API/配置）"));
    prov = first;
    node.providerId = first.id;
    if (!node.model) node.model = ((first.models || [])[0]) || "";
  }
  if (!String(prov.apiKey || "").trim()) throw new Error(I18n.t("该服务商未填写 API Key（设置 · API/配置）"));
  const prompt = pluginFillTemplate(def.call.prompt || "", node, def);
  if (!String(prompt).trim()) throw new Error(I18n.t("提示词为空（请接入上游或填写参数）"));
  const spec = {
    provider: typeof requestProviderOf === "function" ? requestProviderOf(prov, node.model) : prov,
    kind: "text",
    model: node.model || ((prov.models || [])[0] || ""),
    temperature:
      node.temperature == null ? Number(def.call.temperature) || 0.7 : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    effort: typeof normalizeTextEffort === "function" ? normalizeTextEffort(node.effort || def.call.effort) : undefined,
    prompt: def.call.system ? String(def.call.system) + "\n\n" + prompt : prompt,
    texts: [],
    images: [],
    refImage: "",
    abKey: node._abKey || "",
  };
  const delta = (t) => {
    node.outputText = String(node.outputText || "") + String(t || "");
    node.pluginStatus = I18n.t("处理中… ") + String(node.outputText).length + I18n.t(" 字符");
    renderCanvas();
  };
  node.outputText = "";
  const rr = await apiCallTextStream(spec, null, delta);
  if (node._aborted) return;
  const text = String((rr && rr.text) || node.outputText || "").trim();
  if (!text) throw new Error(I18n.t("模型没有返回内容"));
  node.outputText = text;
  node.output = { kind: "text", text: text, title: node.title || "" };
  /* 出端口逐个赋值：call.output 指定的那个端口拿全文，其余文本端口也拿同一份（多数节点只有一个） */
  for (const o of def.outputs || []) {
    if (o.kind === "text") node.outputPaths[o.id] = text;
  }
}

/** HTTP 类：主进程替本节点发请求（只允许本机地址），支持轮询与 JSON 取值 */
async function runPluginHttpNode(node, def, quiet) {
  const call = def.call || {};
  const url = pluginFillTemplate(call.url || "", node, def).trim();
  if (!url) throw new Error(I18n.t("插件清单没有配置 url"));
  let body = "";
  if (call.bodyJson) body = JSON.stringify(pluginFillJson(call.bodyJson, node, def));
  else if (call.body) body = pluginFillTemplate(call.body, node, def);
  const headers = {};
  for (const [k, v] of Object.entries(call.headers || {})) headers[k] = pluginFillTemplate(String(v), node, def);
  const send = (u, b) =>
    window.api.userPluginsHttp({
      url: u,
      method: call.method || "POST",
      headers: headers,
      body: b == null ? body : b,
      timeoutMs: call.timeoutMs || 120000,
    });
  node.pluginStatus = I18n.t("请求本机接口…");
  renderCanvas();
  let r = await send(url);
  if (!r || !r.ok) {
    const detail = (r && (r.error || (r.text || "").slice(0, 200))) || "";
    throw new Error(
      I18n.t("插件接口调用失败：") + (detail ? detail : "HTTP " + ((r && r.status) || "?")) +
        "\n" + I18n.t("（插件不托管后端：请按插件 README 启动它）"),
    );
  }
  let payload = r.json != null ? r.json : r.text;
  /* 异步后端：提交拿 id → 轮询取结果 */
  if (call.poll && call.poll.url) {
    const pollUrl = pluginFillTemplate(call.poll.url, node, def);
    const deadline = Date.now() + (call.timeoutMs || 120000);
    let tries = 0;
    for (;;) {
      if (node._aborted) return;
      tries++;
      if (tries > (call.poll.maxTries || 120) || Date.now() > deadline) {
        throw new Error(I18n.t("插件接口轮询超时"));
      }
      await new Promise((res) => setTimeout(res, call.poll.intervalMs || 1500));
      const pr = await window.api.userPluginsHttp({
        url: pollUrl,
        method: "GET",
        timeoutMs: Math.min(60000, call.timeoutMs || 60000),
      });
      if (!pr || !pr.ok) continue;
      const pj = pr.json != null ? pr.json : pr.text;
      const done = call.poll.donePath
        ? String(pluginPickPath(pj, call.poll.donePath)) === String(call.poll.doneValue)
        : true;
      node.pluginStatus = I18n.t("等待后端… ") + tries;
      renderCanvas();
      if (done) {
        payload = call.poll.resultPath ? pluginPickPath(pj, call.poll.resultPath) : pj;
        break;
      }
    }
  }
  /* 二进制图：主进程把图传成 base64，这里落进画布资产 */
  if (r.imageBase64 && call.imageOut) {
    const saved = await savePluginImage(node, r.imageBase64, call.imageOut);
    if (saved) {
      node.outputPaths[call.imageOut] = saved;
      node.output = { kind: "image", path: saved, text: saved, title: node.title || "" };
      return;
    }
  }
  /* 按 pick 表逐端口取值 */
  let firstText = "";
  for (const o of def.outputs || []) {
    const pathStr = (call.pick || {})[o.id] != null ? call.pick[o.id] : o.id === call.output ? call.output : "";
    let v = pathStr ? pluginPickPath(payload, pathStr) : undefined;
    if (v === undefined && typeof payload !== "object") v = payload;
    if (v === undefined) v = "";
    if (o.kind === "image") node.outputPaths[o.id] = String(v || "");
    else {
      node.outputPaths[o.id] = pluginValueToText(v);
      if (!firstText && node.outputPaths[o.id]) firstText = node.outputPaths[o.id];
    }
  }
  if (!firstText && typeof payload === "string") firstText = payload;
  node.outputText = firstText.slice(0, 20000);
  node.output = firstText ? { kind: "text", text: firstText, title: node.title || "" } : null;
}

/** HTTP 返回的图片落进画布资产（复用既有 assetWriteBase64 通道，不自己拼路径） */
async function savePluginImage(node, base64, portId) {
  try {
    if (!window.api || typeof window.api.assetWriteBase64 !== "function") return "";
    const name =
      String(node.title || "plugin").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) +
      "-" +
      String(portId || "out");
    const r = await window.api.assetWriteBase64(S.wf.id, name, base64, "png");
    return (r && (r.path || r.file)) || "";
  } catch {
    return "";
  }
}

/** 「试运行此节点」：插件详情里对单个节点跑一次示例（不落画布，临时对象） */
async function tryRunPluginNode(kind) {
  const def = pluginNodeDef(kind);
  if (!def) return { ok: false, error: I18n.t("节点定义未加载") };
  const dummy = {
    id: "try-" + kind,
    kind: kind,
    title: def.title && (def.title.zh || def.title.en),
    pluginParams: {},
    outputPaths: {},
  };
  for (const p of def.params || []) dummy.pluginParams[p.id] = p.def;
  try {
    if ((def.call || {}).kind === "model") {
      const prov = (S.config.providers || [])[0];
      if (!prov) return { ok: false, error: I18n.t("未配置服务商") };
      dummy.providerId = prov.id;
      dummy.model = (prov.models || [])[0] || "";
      /* 试运行没有上游连线：模板里的输入占位符填空串，只验证链路通不通 */
      await runPluginModelNode(dummy, def, true);
      return { ok: true, output: dummy.outputText };
    }
    await runPluginHttpNode(dummy, def, true);
    return { ok: true, output: dummy.outputText, paths: dummy.outputPaths };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

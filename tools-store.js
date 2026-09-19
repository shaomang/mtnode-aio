"use strict";

/* ── 主进程侧「工具库」存储 ───────────────────────────────────────────
 * 跨画布复用的工具包落盘：<数据目录>/tools/<id>.json（每工具一文件；数据目录
 * 与画布 save/ 同一根 DATA()，跟随「配置数据目录」迁移）。
 *
 * 完整工具包 = 工具定义（toolConfig：名称 / 描述 / 入出参数）+ 内部图 JSON 快照：
 *   {
 *     id, kind: "tool" | "function", name, description,
 *     inputs:  [{name, kind}],      // kind ∈ text | image
 *     outputs: [{name, kind}],
 *     always: false,                // 「会话随时可调用」开关（默认关 · 供 Agent
 *                                   // 工具调用链路 func call 消费，本模块只存不管；
 *                                   // 函数条目恒 false —— 该链路执行的是工具的内部图）
 *     graph: { rootId, nodes:[...], wires:[...] },   // 内部图快照（插入画布即用）
 *     createdAt, updatedAt
 *   }
 *
 * 工具节点包＝超级变体 + 其内部子图；函数节点包（kind "function"）＝单节点图
 * （graph 只有那一个函数节点、wires 恒空），存档与插入链路完全同一份。
 *
 * 渲染层没有 fs：列举 / 读取 / 保存 / 删除 / 改名 / 开关 全部经这里的 IPC
 * （preload 白名单桥 api.tools*）。原子写沿用 config-providers 的
 * readJson / writeJson（tmp + rename）。
 * ─────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const { ipcMain } = require("electron");
const { readJson, writeJson } = require("./config-providers.js");

const TOOL_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const PARAM_KINDS = { text: 1, image: 1 };

let getDataDir = () => "";
let t = (s) => String(s == null ? "" : s);

function toolsRoot() {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("工具库存储未初始化（缺少数据目录）"));
  return path.join(d, "tools");
}
const toolPath = (id) => path.join(toolsRoot(), String(id) + ".json");

function badArg(msg) {
  return { ok: false, error: msg };
}
function fail(err) {
  return { ok: false, error: String((err && err.message) || err) };
}
function genId() {
  return "tl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
/* 参数表归一：确保 [{name, kind}]，kind 只认 text | image（缺省 text） */
function normParams(list) {
  if (!Array.isArray(list)) return [];
  return list.map((e, i) => {
    if (e == null || typeof e !== "object") e = {};
    const name = String(e.name == null ? "" : e.name).trim();
    const kind = String(e.kind || "text");
    return { name: name || t("参数 ") + (i + 1), kind: PARAM_KINDS[kind] ? kind : "text" };
  });
}
function readTool(id) {
  const p = toolPath(id);
  if (!fs.existsSync(p)) return null;
  const j = readJson(p, null);
  return j && typeof j === "object" ? j : null;
}
/* 条目类型（"tool" / "function"）：优先读包上显式的 kind；老包没有该字段时按内部图
   根节点的 kind 推断（函数节点＝kind "function"，工具节点＝kind "super" + tool:true
   或旧形态 kind "tool"）。渲染层靠它区分清单徽标与「不进 Agent 可调用清单」。 */
function entryKind(j) {
  const k = String((j && j.kind) || "");
  if (k === "function" || k === "tool") return k;
  return graphRootKind(j) === "function" ? "function" : "tool";
}
function graphRootKind(j) {
  const g = j && j.graph && typeof j.graph === "object" ? j.graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const rootId = String(g.rootId || "");
  const root =
    nodes.find((n) => n && String(n.id || "") === rootId) || nodes[0] || null;
  return root && root.kind ? String(root.kind) : "";
}
function listTools() {
  const root = toolsRoot();
  let names = [];
  try {
    /* 只认「合法工具 id + .json」：_builtin.json（内置条目的开关覆写）与任何
       临时 / 备份文件都不会被当成工具条目列出来 */
    names = fs
      .readdirSync(root)
      .filter((f) => f.endsWith(".json") && TOOL_ID_RE.test(f.slice(0, -5)));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const j = readJson(path.join(root, f), null);
      if (!j || typeof j !== "object") continue;
      const g = j.graph && typeof j.graph === "object" ? j.graph : {};
      out.push({
        id: String(j.id || f.slice(0, -5)),
        kind: entryKind(j),
        name: String(j.name || ""),
        description: String(j.description || ""),
        inputs: Array.isArray(j.inputs) ? j.inputs : [],
        outputs: Array.isArray(j.outputs) ? j.outputs : [],
        always: !!j.always,
        createdAt: Number(j.createdAt) || 0,
        updatedAt: Number(j.updatedAt) || 0,
        nodeCount: Array.isArray(g.nodes) ? g.nodes.length : 0,
        wireCount: Array.isArray(g.wires) ? g.wires.length : 0,
      });
    } catch {}
  }
  out.sort(
    (a, b) =>
      (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
  );
  return out;
}
/* 改名时同步快照里根节点的名字与标题（标题仍为旧名才跟随，手动改过的标题保留）：
   工具节点写 toolConfig.name，函数节点写 fnName —— 与渲染层 applyToolConfigName /
   applyFnLibName 同口径。 */
function patchGraphName(graph, rootId, oldName, name) {
  const g = graph && typeof graph === "object" ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const root = nodes.find((n) => n && String(n.id || "") === String(rootId || ""));
  if (!root) return;
  if (root.kind === "function") {
    root.fnName = name;
    const tn = String(root.title || "");
    if (!tn || tn === oldName || /^函数(\s*\d+)?$/.test(tn)) root.title = name;
    return;
  }
  if (root.toolConfig && typeof root.toolConfig === "object") {
    root.toolConfig.name = name;
    const tn = String(root.title || "");
    if (!tn || tn === oldName) root.title = name;
  }
}

/* ── 应用内置条目（随包发版的「开箱即用」工具包）────────────────────
 * 真源：renderer/preset-tools.json（与 renderer 一起随包发；改它 = 改内置清单）。
 * 库里没有对应文件 —— 内置条目不是用户数据，不该被删 / 改名，也没必要在
 * %APPDATA% 里存一份副本。列表与读取时现读现拼，id 统一加 "builtin:" 前缀
 * （用户工具 id 走 genId()，永远不会长这样），所以「插入画布 / 会话随时可调用」
 * 两条消费路径（都按 id 取全量包）天然认得它。 */
const BUILTIN_ID_PREFIX = "builtin:";
let builtinCache = null;

function builtinManifestPath() {
  return path.join(__dirname, "renderer", "preset-tools.json");
}
/* 读内置清单（读不到 / 格式坏 → 空数组，不影响用户工具；结果缓存一份） */
function builtinTools() {
  if (builtinCache) return builtinCache;
  let j = null;
  try {
    j = readJson(builtinManifestPath(), null);
  } catch {}
  const list = j && Array.isArray(j.tools) ? j.tools : [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const key = String(raw.key || "").trim();
    const name = String(raw.name || "").trim();
    const g = raw.graph && typeof raw.graph === "object" ? raw.graph : {};
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    if (!key || !name || !nodes.length) continue;
    out.push({
      id: BUILTIN_ID_PREFIX + key,
      kind: raw.kind === "function" ? "function" : "tool",
      name: name,
      description: String(raw.description || ""),
      inputs: normParams(raw.inputs),
      outputs: normParams(raw.outputs),
      always: !!raw.always,
      builtin: true,
      presets: raw.presets && typeof raw.presets === "object" ? raw.presets : null,
      graph: {
        rootId: String(g.rootId || ""),
        nodes: nodes,
        wires: Array.isArray(g.wires) ? g.wires : [],
      },
      createdAt: Number(raw.createdAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    });
  }
  builtinCache = out;
  return out;
}
function builtinEntry(id) {
  const s = String(id || "");
  if (!s.startsWith(BUILTIN_ID_PREFIX)) return null;
  const key = s.slice(BUILTIN_ID_PREFIX.length);
  return builtinTools().find((t) => t.id === s || t.id === BUILTIN_ID_PREFIX + key) || null;
}
/* 内置条目也可以有「会话随时可调用」开关：用户开关状态不能写回随包文件，
    因此在数据目录里存一份覆写 tools/_builtin.json（{ "<key>": bool }，幂等、可删）。
    这个文件名不以合法工具 id 开头、也不是 <id>.json，用户工具的列举永远不会读到它。 */
function builtinAlwaysFile() {
  return path.join(toolsRoot(), "_builtin.json");
}
function builtinAlwaysMap() {
  try {
    const j = readJson(builtinAlwaysFile(), null);
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
function builtinAlwaysOf(id, dflt) {
  const key = String(id || "").replace(BUILTIN_ID_PREFIX, "");
  const m = builtinAlwaysMap();
  return typeof m[key] === "boolean" ? m[key] : !!dflt;
}
function writeBuiltinAlways(id, always) {
  const key = String(id || "").replace(BUILTIN_ID_PREFIX, "");
  const m = builtinAlwaysMap();
  m[key] = !!always;
  writeJson(builtinAlwaysFile(), m);
}
/* 列表用：去掉 graph（轻量口径与 listTools 一致）并吃进开关覆写。
   函数条目的 always 恒 false —— 会话可调用链路执行的是工具节点的内部图，
   函数包没有那条执行路（渲染层也不给函数条目这个开关，两端口径一致）。 */
function builtinListEntry(t) {
  return {
    id: t.id,
    kind: entryKind(t),
    name: t.name,
    description: t.description,
    inputs: t.inputs,
    outputs: t.outputs,
    always: entryKind(t) === "function" ? false : builtinAlwaysOf(t.id, t.always),
    builtin: true,
    presets: t.presets,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    nodeCount: t.graph.nodes.length,
    wireCount: t.graph.wires.length,
  };
}

function registerToolsIpc(opts) {
  opts = opts || {};
  if (typeof opts.getDataDir === "function") getDataDir = opts.getDataDir;
  if (typeof opts.t === "function") t = opts.t;

  ipcMain.handle("tools:list", () => {
    try {
      /* 内置条目排在最前（开箱即用、不随用户保存时间浮动），其后才是用户工具 */
      const builtins = builtinTools().map(builtinListEntry);
      return { ok: true, tools: builtins.concat(listTools()) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("tools:get", (e, id) => {
    const bid = builtinEntry(id);
    if (bid)
      return {
        ok: true,
        tool: Object.assign({}, bid, {
          always:
            entryKind(bid) === "function" ? false : builtinAlwaysOf(bid.id, bid.always),
        }),
      };
    if (!TOOL_ID_RE.test(String(id || ""))) return badArg(t("非法工具 id"));
    try {
      const j = readTool(String(id));
      return j ? { ok: true, tool: j } : { ok: false, error: t("工具不存在") };
    } catch (err) {
      return fail(err);
    }
  });

  /* 保存（新增或覆盖）：同名工具由渲染层先查后确认覆盖，这里只按 id 落盘；
     无 id / id 不存在 → 生成新 id */
  ipcMain.handle("tools:save", (e, pkg) => {
    try {
      if (pkg == null || typeof pkg !== "object")
        return badArg(t("工具包格式错误"));
      const name = String(pkg.name == null ? "" : pkg.name).trim();
      if (!name) return badArg(t("工具名不能为空"));
      const now = Date.now();
      let id = String(pkg.id || "").trim();
      const g = pkg.graph && typeof pkg.graph === "object" ? pkg.graph : {};
      const next = {
        id: id,
        /* kind 只用于清单徽标与「是否进 Agent 可调用清单」；判定一律按包内根节点的 kind */
        kind: pkg.kind === "function" ? "function" : "tool",
        name: name,
        description: String(pkg.description || ""),
        inputs: normParams(pkg.inputs),
        outputs: normParams(pkg.outputs),
        always: !!pkg.always,
        graph: {
          rootId: String(g.rootId || ""),
          nodes: Array.isArray(g.nodes) ? g.nodes : [],
          wires: Array.isArray(g.wires) ? g.wires : [],
        },
        createdAt: now,
        updatedAt: now,
      };
      if (id && TOOL_ID_RE.test(id) && readTool(id)) {
        const prev = readTool(id);
        if (prev && prev.createdAt) next.createdAt = Number(prev.createdAt) || now;
      } else {
        id = genId();
        next.id = id;
      }
      writeTool(next);
      return { ok: true, id: id };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("tools:delete", (e, id) => {
    if (builtinEntry(id))
      return badArg(t("内置工具不可删除（它随应用发版，不是本机数据）"));
    if (!TOOL_ID_RE.test(String(id || ""))) return badArg(t("非法工具 id"));
    try {
      const p = toolPath(String(id));
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  /* 改名 / 改描述 / 切换「会话随时可调用」（供 Agent 工具调用链路） */
  ipcMain.handle("tools:patch", (e, arg) => {
    const id = arg && arg.id;
    const patch = (arg && arg.patch) || {};
    /* 内置条目：只允许「会话随时可调用」这一个开关（写到数据目录的覆写文件里），
       改名 / 改描述一律拒绝 —— 随包文件是本机无关的，改了下次升级就没了。 */
    const bid = builtinEntry(id);
    if (bid) {
      try {
        if (typeof patch.always === "boolean" && entryKind(bid) === "function")
          return badArg(t("函数条目不支持「会话随时可调用」（该链路跑的是工具节点的内部图）"));
        if (typeof patch.always === "boolean") {
          writeBuiltinAlways(bid.id, patch.always);
          return { ok: true };
        }
        return badArg(t("内置工具只能切换「会话随时可调用」，不能改名 / 改描述"));
      } catch (err) {
        return fail(err);
      }
    }
    if (!TOOL_ID_RE.test(String(id || ""))) return badArg(t("非法工具 id"));
    try {
      const j = readTool(String(id));
      if (!j) return { ok: false, error: t("工具不存在") };
      if (typeof patch.name === "string") {
        const oldName = String(j.name || "");
        const name = patch.name.trim();
        if (!name) return badArg(t("工具名不能为空"));
        j.name = name;
        patchGraphName(j.graph, j.graph && j.graph.rootId, oldName, name);
      }
      if (typeof patch.description === "string") j.description = patch.description;
      if (typeof patch.always === "boolean") j.always = patch.always;
      j.updatedAt = Date.now();
      writeTool(j);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });
}

function writeTool(pkg) {
  writeJson(toolPath(pkg.id), pkg);
}

module.exports = { registerToolsIpc };

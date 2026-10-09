"use strict";
/**
 * 用户自建插件（声明式 · 免源码 · 升级不失效）
 * ===========================================
 * 用户把插件文件夹放进 `<数据目录>/user-plugins/<插件id>/`，里面固定一个清单
 * `mtnode-plugin.json`，应用**每次启动扫一遍**就把它的画布节点 / MCP 服务器 / 技能
 * 装进 MTNode —— 全程不碰源码、不需要重新打包、也不经过应用商店。
 *
 * 为什么放数据目录：`%APPDATA%\pipeline-console` 是升级唯一不会被覆盖的地方
 * （安装目录 + resources/*-pack 每次更新都被 NSIS 静默替换，见 updater.js / installer.nsh），
 * 所以「不随版本更新失效」的物理保障就是这条路径约定。
 *
 * 安全边界（与用户共识一致）：插件目录里**不允许任何被执行的自定义 JS**。
 * 清单只是一份 JSON 声明：节点要调模型就交给渲染层的 apiCallTextStream，要调本机后端
 * 就走本模块的 httpCall（主进程发请求）；插件自己带的程序（python 服务等）不由此处托管，
 * 由插件 README 交代用户自行启动。
 *
 * 版本兼容（双向）：清单可写 minAppVersion / maxAppVersion；应用容忍旧清单的未知字段（忽略）、
 * 缺字段（补默认）。不兼容的插件不会被静默丢掉 —— 卡片上标「与当前版本不兼容」并给出修复入口。
 */
const { ipcMain, app, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const pluginErrors = require("../plugin-error-repair.js");

const MANIFEST_NAME = "mtnode-plugin.json";
const ALT_MANIFEST_NAMES = ["plugin.json"];
const README_NAMES = ["README.md", "readme.md", "README.txt"];
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/* 节点 id：加插件前缀后仍是画布上的 kind 字面值，必须能安全进 JSON / 选择器 */
const NODE_ID_OK = /^[a-z][a-z0-9_]{0,47}$/;
const TEMPLATE_DIR = "_example";
/* 诊断导出与 HTTP 调用的边界 */
const MAX_HTTP_BODY = 8 * 1024 * 1024;
const MAX_ZIP = 64 * 1024 * 1024;
const EXPORT_KEEP = 20;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
/* 内置画布节点 kind 的保留字：插件前缀是 `up_<id>`，若 id 去掉非法字符后与内置 kind 同名
   （如 id 写着 up_proc_text 或 input_text），就会覆盖内置节点的渲染 / 执行分支 —— 直接拒绝。 */
const RESERVED_KINDS = new Set([
  "input_text", "input_image", "input_audio", "input_video", "input_any", "input_file",
  "asset", "db_table", "db_replica", "proc_text", "proc_image", "save", "save_pdf",
  "task", "agent_task", "control", "wait_file", "timer", "judge", "delayer", "sequencer",
  "gate", "splitter", "counter", "mutex", "global", "function", "tool", "super", "super_io",
  "execute", "deliver", "ltout", "ltart", "split", "merge", "net_recv", "net_send",
  "music_gen", "yue_gen", "sensenova_gen", "tts_gen", "breeze_gen", "video_gen",
  "video_upscale", "video_interp", "remotion",
]);

let getDataDir = null;
let getMainWin = null;
let getAppVersion = null;
let appRoot = "";
/* 本次启动的扫描结果（用户插件目录里认出来的插件，按 id） */
let scanned = [];
let scannedAt = 0;
let healthChecked = false;

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function userPluginsRoot() {
  return mk(join(getDataDir(), "user-plugins"));
}
function exportsDir() {
  return mk(join(getDataDir(), "exports"));
}
/** 把当前**可用**的插件节点定义写给 Agent 网关（<dshHome>/user-plugin-kinds.json）：
 *  dsh/gateway/canvas-plugin.mjs 在插件加载时读它，把 kind 并进 create.kind 的 enum，
 *  并把「端口与用法」附进工具描述 —— 会话 / 助手因此也能建插件节点。
 *  写失败不影响插件本身（Agent 侧少几个 kind 而已）。 */
function writeAgentKinds() {
  try {
    const nodes = activeNodeDefs().map((n) => ({
      kind: n.kind,
      id: n.id,
      title: n.title,
      desc: n.desc,
      pluginId: n.pluginId,
      pluginTitle: n.pluginTitle,
      inputs: (n.inputs || []).map((p) => ({ id: p.id, kind: p.kind, label: p.label })),
      outputs: (n.outputs || []).map((p) => ({ id: p.id, kind: p.kind, label: p.label })),
    }));
    writeJson(join(getDataDir(), "dsh-home", "user-plugin-kinds.json"), {
      version: 1,
      updatedAt: Date.now(),
      appVersion: appVersion(),
      nodes,
    });
  } catch {}
}
function statePath() {
  return join(userPluginsRoot(), "_state.json");
}
function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
function readText(p, cap) {
  try {
    const buf = fs.readFileSync(p);
    const s = buf.slice(0, cap || 256 * 1024).toString("utf8");
    return s;
  } catch {
    return "";
  }
}
function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
function copyDirRecursive(src, dest) {
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}
function listFilesRec(dir, base, out, depth) {
  const root = base == null ? dir : base;
  const acc = out || [];
  const d = depth == null ? 0 : depth;
  if (d > 6) return acc;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of ents) {
    const p = join(dir, ent.name);
    try {
      if (ent.isDirectory()) listFilesRec(p, root, acc, d + 1);
      else if (ent.isFile()) acc.push(path.relative(root, p).replace(/\\/g, "/"));
    } catch {}
  }
  return acc;
}
function appVersion() {
  try {
    return String((typeof getAppVersion === "function" && getAppVersion()) || app.getVersion() || "0.0.0");
  } catch {
    return "0.0.0";
  }
}
/* ── 版本比较：x.y.z 数字逐段比，缺段补 0（足够覆盖本仓 1.2.3 的版本口径） ── */
function verParts(v) {
  return String(v || "")
    .replace(/^v/i, "")
    .split(/[.\-+]/)
    .slice(0, 4)
    .map((x) => {
      const n = parseInt(String(x).replace(/[^0-9]/g, ""), 10);
      return isFinite(n) ? n : 0;
    });
}
function verCmp(a, b) {
  const A = verParts(a);
  const B = verParts(b);
  for (let i = 0; i < 4; i++) {
    const x = A[i] || 0;
    const y = B[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
/* 语言取值：{zh,en} 对象（缺 en 退回 zh）或纯字符串 */
function loc(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v.zh || v.en || v["zh-CN"] || "").trim();
  return String(v);
}
function locObj(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return { zh: String(v.zh || v.en || "").trim(), en: String(v.en || v.zh || "").trim() };
  }
  const s = String(v == null ? "" : v).trim();
  return { zh: s, en: s };
}

/* ══════════════════════════ 清单规格化 ══════════════════════════ */

/* 端口/参数 id：模板占位符里要用，限死字符集 */
function safeParamId(raw, fallback) {
  const s = String(raw == null ? "" : raw)
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_");
  if (!s) return fallback;
  return /^[A-Za-z_]/.test(s) ? s.slice(0, 40) : "p_" + s.slice(0, 38);
}

function normPort(raw, i, used) {
  const o = raw && typeof raw === "object" ? raw : {};
  let id = safeParamId(o.id || o.name, "in" + (i + 1));
  while (used.has(id)) id = id + "_" + (i + 1);
  used.add(id);
  const kind = String(o.kind || o.type || "text").toLowerCase() === "image" ? "image" : "text";
  return {
    id,
    kind,
    label: locObj(o.label || o.title || o.name || id),
    /* list=true：可重复连多条线，运行时值 = 按连线顺序的数组（见画布侧 getPluginNodeInputs） */
    list: !!o.list,
    required: !!o.required,
    desc: locObj(o.desc || o.description || ""),
  };
}

function normParam(raw, i, used) {
  const o = raw && typeof raw === "object" ? raw : {};
  let id = safeParamId(o.id || o.name, "p" + (i + 1));
  while (used.has(id)) id = id + "_" + (i + 1);
  used.add(id);
  const type = ["text", "textarea", "number", "select", "bool"].includes(String(o.type || ""))
    ? String(o.type)
    : "text";
  const opts = Array.isArray(o.options)
    ? o.options
        .map((x) =>
          x && typeof x === "object"
            ? { value: String(x.value == null ? "" : x.value), label: locObj(x.label || x.title || x.value) }
            : { value: String(x == null ? "" : x), label: locObj(x) },
        )
        .slice(0, 60)
    : [];
  return {
    id,
    type,
    label: locObj(o.label || o.title || o.name || id),
    desc: locObj(o.desc || o.description || ""),
    placeholder: String(o.placeholder || ""),
    options: opts,
    def:
      type === "bool"
        ? !!o.default
        : type === "number"
          ? Number(o.default) || 0
          : String(o.default == null ? "" : o.default),
  };
}

/**
 * 规格化一个节点的调用声明。
 * model 型：prompt 模板 → 走 MTNode 已配好的服务商与模型（渲染层 apiCallTextStream）。
 * http 型：url/method/headers/body 模板 → 主进程发请求（渲染层不直连本机端口）。
 */
function normCall(raw, node) {
  const o = raw && typeof raw === "object" ? raw : {};
  const kind = String(o.kind || o.type || "http").toLowerCase() === "model" ? "model" : "http";
  if (kind === "model") {
    return {
      kind,
      prompt: String(o.prompt || ""),
      system: String(o.system || ""),
      temperature:
        o.temperature == null ? 0.7 : Math.max(0, Math.min(2, Number(o.temperature) || 0)),
      effort: ["off", "low", "medium", "high", "xhigh", "max"].includes(String(o.effort || ""))
        ? String(o.effort)
        : "high",
      /* 输出落到哪个端口（缺省第一个 text 出参） */
      output: String(o.output || ""),
    };
  }
  return {
    kind,
    url: String(o.url || ""),
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(o.method || "").toUpperCase())
      ? String(o.method).toUpperCase()
      : "POST",
    headers: o.headers && typeof o.headers === "object" ? o.headers : {},
    body: String(o.body || ""),
    bodyJson: o.bodyJson && typeof o.bodyJson === "object" ? o.bodyJson : null,
    timeoutMs: Math.max(1000, Math.min(1800000, Number(o.timeoutMs) || 120000)),
    /* 异步后端（ComfyUI 风格）：先提交拿 id，再轮询取结果 */
    poll: o.poll && typeof o.poll === "object" ? {
      url: String(o.poll.url || ""),
      intervalMs: Math.max(300, Math.min(30000, Number(o.poll.intervalMs) || 1500)),
      maxTries: Math.max(1, Math.min(600, Number(o.poll.maxTries) || 120)),
      donePath: String(o.poll.donePath || ""),
      doneValue: o.poll.doneValue == null ? "" : o.poll.doneValue,
      resultPath: String(o.poll.resultPath || ""),
    } : null,
    /* 从响应 JSON 里取各出端口的值：out 端口 id → JSON 路径（a.b.0.c） */
    pick: o.pick && typeof o.pick === "object" ? o.pick : {},
    /* 响应是二制图（png/jpg）时把字节落到资产目录并把路径交给该出端口 */
    imageOut: String(o.imageOut || ""),
    output: String(o.output || ""),
  };
}

function normNode(raw, plugin, i, usedNodeIds) {
  const o = raw && typeof raw === "object" ? raw : {};
  let id = String(o.id || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!NODE_ID_OK.test(id)) id = "node_" + (i + 1);
  const kind = plugin.prefix + "_" + id.replace(/^[a-z]/, (c) => c);
  if (usedNodeIds.has(kind)) return { err: "节点 id 重复：" + id };
  usedNodeIds.add(kind);
  const usedIn = new Set();
  const usedOut = new Set();
  const inputs = (Array.isArray(o.inputs) ? o.inputs : []).slice(0, 12).map((x, k) => normPort(x, k, usedIn));
  const outputs = (Array.isArray(o.outputs) ? o.outputs : []).slice(0, 12).map((x, k) => normPort(x, k, usedOut));
  const usedP = new Set();
  const params = (Array.isArray(o.params) ? o.params : []).slice(0, 24).map((x, k) => normParam(x, k, usedP));
  const call = normCall(o.call, o);
  const title = locObj(o.title || o.name || id);
  /* 输出端口 → 出参（模型型默认第一个 text 出参；HTTP 型默认 pick[outId] / output） */
  const textOut = outputs.find((p) => p.kind === "text") || outputs[0] || null;
  if (call.kind === "model" && !call.output && textOut) call.output = textOut.id;
  if (call.kind === "http" && !call.output && textOut) call.output = textOut.id;
  return {
    kind,
    id,
    title,
    desc: locObj(o.desc || o.description || ""),
    icon: "plugin",
    w: Math.max(200, Math.min(560, Number(o.w) || 260)),
    h: Math.max(120, Math.min(720, Number(o.h) || 190)),
    inputs,
    outputs,
    params,
    call,
  };
}

/**
 * 规格化一份清单。**宽容**：未知字段忽略、缺字段补默认、单点错误只降级那一项
 * （节点坏了不牵连 MCP / 技能，反之亦然）。返回 { ok, doc, errors, warnings }。
 */
function normalizeManifest(raw, folderId) {
  const errors = [];
  const warnings = [];
  const o = raw && typeof raw === "object" ? raw : {};
  let id = String(o.id || folderId || "").trim();
  if (!ID_OK.test(id)) {
    errors.push("id 非法（1-64 位字母/数字/._-）：" + String(o.id || ""));
    id = ID_OK.test(folderId || "") ? String(folderId) : "";
  }
  if (!id) return { ok: false, doc: null, errors: errors.length ? errors : ["缺少 id"], warnings };
  /* 节点 kind 前缀：只留小写字母数字下划线，避免与内置 kind 撞（内置全是已知字面值） */
  const prefix = "up_" + id.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 24);
  const plugin = { id, prefix };
  const usedNodeIds = new Set();
  const nodes = [];
  for (const [i, n] of (Array.isArray(o.nodes) ? o.nodes : []).slice(0, 24).entries()) {
    const r = normNode(n, plugin, i, usedNodeIds);
    if (r && r.err) errors.push(r.err);
    else if (r && r.kind) {
      /* 撞内置 kind = 会覆盖内置节点的渲染 / 执行：直接拒绝这个节点，别的节点照旧。
         本仓的插件 kind 已由 `up_` 前缀隔开，这条是防「前缀被改坏 / 清单被手改」的兜底。 */
      if (RESERVED_KINDS.has(r.kind)) errors.push("节点 id 与内置节点重名：" + r.kind);
      else nodes.push(r);
    }
  }
  /* MCP 服务器：{name, transport, command, args, url, enabled} */
  const mcp = (Array.isArray(o.mcp) ? o.mcp : [])
    .slice(0, 12)
    .map((x) => {
      const m = x && typeof x === "object" ? x : {};
      const name = String(m.name || "").trim();
      const transport = String(m.transport || (m.url ? "http" : "stdio")).toLowerCase() === "http" ? "http" : "stdio";
      return {
        name,
        transport,
        command: String(m.command || ""),
        args: (Array.isArray(m.args) ? m.args : m.args ? String(m.args).split(/\s+/) : []).map(String),
        url: String(m.url || ""),
        enabled: m.enabled !== false,
      };
    })
    .filter((m) => {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(m.name)) {
        if (m.name) errors.push("MCP 服务器名非法：" + m.name);
        return false;
      }
      if (m.transport === "stdio" && !m.command) {
        errors.push("MCP 服务器 " + m.name + " 缺 command");
        return false;
      }
      if (m.transport === "http" && !/^https?:\/\//.test(m.url)) {
        errors.push("MCP 服务器 " + m.name + " 的 url 需为 http(s)");
        return false;
      }
      return true;
    });
  /* 技能：目录名 + SKILL.md（在插件目录里用 skills/<dir>/SKILL.md 承载，或清单内联 body） */
  const skills = (Array.isArray(o.skills) ? o.skills : [])
    .slice(0, 24)
    .map((x) => {
      const s = typeof x === "string" ? { dir: x } : x && typeof x === "object" ? x : {};
      const rawName = String(s.dir || s.name || "").split("/").filter(Boolean).pop() || "";
      const dir = rawName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
      return {
        name: /^[a-z0-9][a-z0-9-]{0,63}$/.test(dir) ? dir : "",
        dir: String(s.dir || "").replace(/\\/g, "/").replace(/^\.\//, ""),
        description: String(s.description || ""),
        body: String(s.body || ""),
      };
    })
    .filter((s) => {
      if (!s.name) {
        errors.push("技能名需为 kebab-case");
        return false;
      }
      return true;
    });
  const doc = {
    id,
    prefix,
    version: String(o.version || "0.0.0"),
    minAppVersion: String(o.minAppVersion || ""),
    maxAppVersion: String(o.maxAppVersion || ""),
    title: locObj(o.title || id),
    subtitle: locObj(o.subtitle || o.description || ""),
    author: String(o.author || ""),
    homepage: String(o.homepage || ""),
    /* 不托管：这里只是给用户看的说明（后端怎么起、健康检查地址） */
    backend: o.backend && typeof o.backend === "object" ? {
      hint: locObj(o.backend.hint || ""),
      healthUrl: String(o.backend.healthUrl || ""),
      startCommand: String(o.backend.startCommand || ""),
    } : null,
    nodes,
    mcp,
    skills,
    unknownKeys: Object.keys(o).filter(
      (k) =>
        ![
          "id",
          "version",
          "minAppVersion",
          "maxAppVersion",
          "title",
          "subtitle",
          "description",
          "author",
          "homepage",
          "backend",
          "nodes",
          "mcp",
          "skills",
          "$schema",
        ].includes(k),
    ),
  };
  if (!nodes.length && !mcp.length && !skills.length) {
    errors.push("清单里没有任何节点 / MCP 服务器 / 技能");
  }
  if (doc.unknownKeys.length) warnings.push("忽略未知字段：" + doc.unknownKeys.join(", "));
  return { ok: !errors.length, doc, errors, warnings };
}

/* ══════════════════════════ 扫描 ══════════════════════════ */

function findManifest(dir) {
  const p = join(dir, MANIFEST_NAME);
  if (fs.existsSync(p)) return p;
  for (const alt of ALT_MANIFEST_NAMES) {
    const q = join(dir, alt);
    if (fs.existsSync(q)) return q;
  }
  return "";
}
function findReadme(dir) {
  for (const n of README_NAMES) {
    const p = join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return "";
}
function stateOf() {
  const s = readJson(statePath(), {}) || {};
  return {
    disabled: Array.isArray(s.disabled) ? s.disabled.map(String) : [],
    imported: s.imported && typeof s.imported === "object" ? s.imported : {},
    lastHealth: s.lastHealth && typeof s.lastHealth === "object" ? s.lastHealth : null,
  };
}
function writeState(s) {
  writeJson(statePath(), s);
}

/** 读一个插件目录（不递归、不执行任何东西） */
function readPluginDir(dir, folderId, disabledSet) {
  const manifestPath = findManifest(dir);
  const base = {
    id: folderId,
    folder: folderId,
    dir,
    manifestPath,
    dirName: path.basename(dir),
  };
  if (!manifestPath) {
    return Object.assign(base, {
      state: "error",
      errors: ["缺少清单文件 " + MANIFEST_NAME],
      warnings: [],
      nodes: [],
      mcp: [],
      skills: [],
    });
  }
  const raw = readJson(manifestPath, null);
  if (!raw || typeof raw !== "object") {
    return Object.assign(base, {
      state: "error",
      errors: [MANIFEST_NAME + " 不是合法 JSON"],
      warnings: [],
      nodes: [],
      mcp: [],
      skills: [],
    });
  }
  const nz = normalizeManifest(raw, folderId);
  const doc = nz.doc || { id: folderId, prefix: "", title: locObj(folderId) };
  const id = doc.id || folderId;
  const cur = appVersion();
  const tooOld = doc.minAppVersion ? verCmp(cur, doc.minAppVersion) < 0 : false;
  const tooNew = doc.maxAppVersion ? verCmp(cur, doc.maxAppVersion) > 0 : false;
  const disabled = disabledSet.has(id) || disabledSet.has(folderId);
  let state = "normal";
  if (!nz.ok || nz.errors.length) state = "error";
  else if (tooOld || tooNew) state = "incompatible";
  else if (disabled) state = "disabled";
  return Object.assign(base, {
    id,
    version: doc.version,
    minAppVersion: doc.minAppVersion,
    maxAppVersion: doc.maxAppVersion,
    title: doc.title,
    subtitle: doc.subtitle,
    author: doc.author,
    homepage: doc.homepage,
    backend: doc.backend,
    nodes: doc.nodes || [],
    mcp: doc.mcp || [],
    skills: doc.skills || [],
    unknownKeys: doc.unknownKeys || [],
    errors: nz.errors || [],
    warnings: nz.warnings || [],
    incompatible: tooOld ? "min" : tooNew ? "max" : "",
    disabled,
    state,
    appVersion: cur,
    readme: findReadme(dir),
    files: listFilesRec(dir),
  });
}

/** 扫一遍 user-plugins/（每次调用都重新读盘，供「刷新 / 修复」用） */
function scan() {
  const root = userPluginsRoot();
  const st = stateOf();
  const disabledSet = new Set(st.disabled);
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    ents = [];
  }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith("_") || ent.name.startsWith(".")) continue; /* _example / _state.json 不算插件 */
    if (!ID_OK.test(ent.name)) continue;
    out.push(readPluginDir(join(root, ent.name), ent.name, disabledSet));
  }
  out.sort((a, b) => String((a.title && a.title.zh) || a.id).localeCompare(String((b.title && b.title.zh) || b.id), "zh"));
  scanned = out;
  scannedAt = Date.now();
  writeAgentKinds();
  return out;
}
function listPublic(deep) {
  return scanned.map((p) => {
    const o = {
      id: p.id,
      folder: p.folder,
      dir: p.dir,
      version: p.version,
      title: p.title,
      subtitle: p.subtitle,
      author: p.author,
      homepage: p.homepage,
      state: p.state,
      disabled: !!p.disabled,
      incompatible: p.incompatible || "",
      minAppVersion: p.minAppVersion,
      maxAppVersion: p.maxAppVersion,
      appVersion: p.appVersion,
      errors: p.errors,
      warnings: p.warnings,
      backend: p.backend,
      counts: { nodes: p.nodes.length, mcp: p.mcp.length, skills: p.skills.length },
      manifestPath: p.manifestPath,
      readmePath: p.readme || "",
    };
    if (deep) {
      o.nodes = p.nodes.map((n) => ({
        kind: n.kind,
        id: n.id,
        title: n.title,
        desc: n.desc,
        w: n.w,
        h: n.h,
        inputs: n.inputs,
        outputs: n.outputs,
        params: n.params,
        callKind: n.call.kind,
        call: n.call,
      }));
      o.mcp = p.mcp;
      o.skills = p.skills.map((s) => ({ name: s.name, description: s.description, dir: s.dir }));
      o.unknownKeys = p.unknownKeys;
    } else {
      o.nodeList = p.nodes.map((n) => ({ kind: n.kind, title: n.title, desc: n.desc }));
    }
    return o;
  });
}
/** 只取可用的节点定义（状态正常且带前缀）——渲染层与 Agent 侧共用 */
function activeNodeDefs() {
  const out = [];
  for (const p of scanned) {
    if (p.state !== "normal") continue;
    for (const n of p.nodes) {
      out.push(
        Object.assign({}, n, {
          pluginId: p.id,
          pluginTitle: p.title,
          pluginState: p.state,
        }),
      );
    }
  }
  return out;
}
function pluginById(id) {
  const s = String(id || "");
  const hit = scanned.find((p) => p.id === s || p.folder === s);
  if (hit) return hit;
  /* 缓存里没有就现扫一遍再找：用户可能刚把文件夹拷进来（或刚点了「修复」），
     拿一份过期的清单说「插件不存在」是最容易误导人的失败方式。 */
  if (!s) return null;
  return scan().find((p) => p.id === s || p.folder === s) || null;
}

/* ══════════════════════════ MCP / 技能联动 ══════════════════════════ */

/**
 * 把插件声明的 MCP 服务器与技能装进 dsh 侧（复用现有适配器，不另造一套）。
 * 幂等：每次都先按名字查现有清单，缺了才加；已存在但来源标记不属于本插件的不动。
 * 返回 { ok, mcp:[{name,status}], skills:[{name,status}] }。
 */
function applyMcpAndSkills(plugin) {
  const out = { ok: true, mcp: [], skills: [], errors: [] };
  if (!plugin || plugin.state !== "normal") {
    return { ok: false, mcp: [], skills: [], errors: ["插件状态不是正常，未应用 MCP / 技能"] };
  }
  const dshHome = join(getDataDir(), "dsh-home");
  /* MCP：直接按 cordis-user.yml 的行格式追加（与 gateway.mjs 的 mcpAdd 同一份写法） */
  const cmpPath = join(dshHome, "cordis-user.yml");
  const MCP_PKG = "@deepseek-ai/dsh-mcp-client";
  for (const m of plugin.mcp) {
    try {
      const cur = readText(cmpPath, 1024 * 1024);
      const marker = "serverName: '" + m.name + "'";
      if (cur.includes(marker)) {
        out.mcp.push({ name: m.name, status: "exists" });
        continue;
      }
      const lines = [
        "",
        "- id: user-mcp-" + plugin.id.replace(/[^a-z0-9]/gi, "").slice(0, 12) + "-" + m.name,
        "  name: '" + MCP_PKG + "'",
        "  config:",
        "    serverName: '" + m.name + "'",
        "    transport: '" + m.transport + "'",
      ];
      if (m.transport === "stdio") {
        lines.push("    command: '" + m.command.replace(/'/g, "''") + "'");
        if (m.args.length)
          lines.push("    args: [" + m.args.map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(", ") + "]");
      } else {
        lines.push("    url: '" + m.url + "'");
      }
      mk(dshHome);
      fs.appendFileSync(cmpPath, lines.join("\n") + "\n", "utf8");
      out.mcp.push({ name: m.name, status: "added" });
    } catch (e) {
      out.mcp.push({ name: m.name, status: "error", error: String((e && e.message) || e) });
      out.errors.push("MCP " + m.name + "：" + String((e && e.message) || e));
    }
  }
  /* 技能：把插件目录里 skills/<dir>/** 复制到 dsh-home/skills/<name>/（或写内联 body） */
  for (const s of plugin.skills) {
    try {
      const destDir = join(dshHome, "skills", s.name);
      if (fs.existsSync(join(destDir, ".builtin"))) {
        out.skills.push({ name: s.name, status: "builtin-skip" });
        continue;
      }
      const srcDir = s.dir ? join(plugin.dir, s.dir) : join(plugin.dir, "skills", s.name);
      let body = s.body;
      if (!body && fs.existsSync(join(srcDir, "SKILL.md"))) body = readText(join(srcDir, "SKILL.md"), 400 * 1024);
      if (!body) {
        out.skills.push({ name: s.name, status: "missing", error: "找不到 SKILL.md" });
        out.errors.push("技能 " + s.name + "：找不到 SKILL.md" + (s.dir ? "（" + s.dir + "）" : ""));
        continue;
      }
      mk(destDir);
      fs.writeFileSync(join(destDir, "SKILL.md"), body, "utf8");
      if (fs.existsSync(srcDir)) {
        for (const rel of listFilesRec(srcDir)) {
          if (rel === "SKILL.md") continue;
          if (rel.includes("..")) continue;
          const dst = join(destDir, ...rel.split("/"));
          mk(path.dirname(dst));
          try {
            fs.copyFileSync(join(srcDir, ...rel.split("/")), dst);
          } catch {}
        }
      }
      /* 来源标记：修复 / 体检靠它认出「这条是本插件装的」 */
      fs.writeFileSync(
        join(destDir, ".mtnode-user-plugin.json"),
        JSON.stringify({ pluginId: plugin.id, pluginVersion: plugin.version, at: Date.now() }, null, 2),
        "utf8",
      );
      out.skills.push({ name: s.name, status: "installed" });
    } catch (e) {
      out.skills.push({ name: s.name, status: "error", error: String((e && e.message) || e) });
      out.errors.push("技能 " + s.name + "：" + String((e && e.message) || e));
    }
  }
  return out;
}

/* ══════════════════════════ 体检 / 修复 ══════════════════════════ */

function healthReport(opts) {
  /* 注意：`scanned.length || scan()` 会在空清单时把**数字 0** 当结果（老写法踩过），必须用三元 */
  const list = scanned.length ? scanned : scan();
  const problems = list
    .filter((p) => p.state !== "normal")
    .map((p) => ({
      id: p.id,
      title: loc(p.title) || p.id,
      state: p.state,
      incompatible: p.incompatible || "",
      minAppVersion: p.minAppVersion,
      maxAppVersion: p.maxAppVersion,
      errors: p.errors,
      warnings: p.warnings,
    }));
  const report = {
    at: Date.now(),
    appVersion: appVersion(),
    root: userPluginsRoot(),
    total: list.length,
    ok: list.filter((p) => p.state === "normal").length,
    problems,
    nodes: activeNodeDefs().length,
    quiet: !!(opts && opts.quiet),
  };
  return report;
}
/** 启动体检：写日志（用户可在日志里看到「哪些插件被跳过、为什么」） */
function runStartupHealth() {
  if (healthChecked) return null;
  healthChecked = true;
  try {
    scan();
    const rep = healthReport({ quiet: true });
    logLine(
      "[user-plugins] 体检：" +
        rep.total +
        " 个插件，" +
        rep.ok +
        " 正常，" +
        rep.problems.length +
        " 有问题 → " +
        userPluginsRoot(),
    );
    for (const p of rep.problems) {
      logLine("[user-plugins] 跳过 " + p.id + "（" + p.state + "）：" + (p.errors[0] || p.warnings[0] || p.incompatible));
      /* 报错总线：让「启动时就发现插件坏了」也能走既有插件报错窗 + 会话修复 */
      pluginErrors.reportPluginError(p.id, {
        code: p.incompatible ? "incompatible_version" : "manifest_invalid",
        message: (p.errors[0] || "") + (p.incompatible ? "（需要 MTNode " + (p.minAppVersion || "") + (p.maxAppVersion ? " ~ " + p.maxAppVersion : "") + "）" : ""),
        phase: "startup",
        installDir: (pluginById(p.id) || {}).dir || "",
      });
    }
    const st = stateOf();
    st.lastHealth = rep;
    writeState(st);
    return rep;
  } catch (e) {
    logLine("[user-plugins] 体检失败：" + String((e && e.message) || e));
    return null;
  }
}
function logLine(msg) {
  try {
    console.log(msg);
  } catch {}
}

/**
 * 修复一个插件：补齐清单缺失字段（写回 mtnode-plugin.json）→ 重建登记（重扫）
 * → 重新应用 MCP / 技能 → 校验本机后端 healthUrl（通了就报 ok）。
 * 返回逐步结果，界面按 step 显示；失败原因原样带回。
 */
async function repairPlugin(id) {
  const steps = [];
  const p = pluginById(id);
  if (!p) return { ok: false, error: "插件不存在：" + String(id || ""), steps };
  /* ① 补缺字段：把规格化后的清单回写（只补不改：已知字段保留原值，未知字段原样留着） */
  try {
    if (p.manifestPath) {
      const raw = readJson(p.manifestPath, {}) || {};
      const before = JSON.stringify(raw);
      const fill = {
        id: raw.id || p.id,
        version: raw.version || p.version || "0.0.0",
        title: raw.title || p.title,
        subtitle: raw.subtitle || p.subtitle || "",
        nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
        mcp: Array.isArray(raw.mcp) ? raw.mcp : [],
        skills: Array.isArray(raw.skills) ? raw.skills : [],
      };
      const merged = Object.assign({}, fill, raw);
      if (JSON.stringify(merged) !== before) {
        writeJson(p.manifestPath, merged);
        steps.push({ step: "manifest", ok: true, note: "已补齐缺失字段" });
      } else {
        steps.push({ step: "manifest", ok: true, note: "清单字段完整" });
      }
    } else {
      steps.push({ step: "manifest", ok: false, error: "没有清单文件" });
    }
  } catch (e) {
    steps.push({ step: "manifest", ok: false, error: String((e && e.message) || e) });
  }
  /* ② 重扫 + 重建登记 */
  scan();
  const again = pluginById(id);
  steps.push({
    step: "rescan",
    ok: !!again && again.state !== "error",
    note: again ? "当前状态：" + stateText(again.state) : "没扫到该插件",
  });
  if (!again) return { ok: false, error: "重扫后找不到插件", steps };
  /* ③ 重新应用 MCP / 技能 */
  if (again.mcp.length || again.skills.length) {
    const r = applyMcpAndSkills(again);
    steps.push({
      step: "ext",
      ok: !r.errors.length,
      note:
        "MCP " + r.mcp.filter((x) => x.status !== "exists").length + " 新增 · 技能 " +
        r.skills.filter((x) => x.status === "installed").length + " 写入",
      error: r.errors.join("; "),
    });
  } else {
    steps.push({ step: "ext", ok: true, note: "无 MCP / 技能声明" });
  }
  /* ④ 后端健康检查（不托管：只探一探，通了说明用户已把后端起起来） */
  const health = again.backend && again.backend.healthUrl ? again.backend.healthUrl : "";
  if (health) {
    const r = await httpCall({ url: health, method: "GET", timeoutMs: 6000 }).catch((e) => ({
      ok: false,
      error: String((e && e.message) || e),
    }));
    steps.push({
      step: "backend",
      ok: !!r.ok,
      note: r.ok ? "后端健康检查通过" : "后端未就绪（插件不托管后端：请按 README 自行启动）",
      error: r.ok ? "" : r.error || ("HTTP " + (r.status || "?")),
    });
  } else {
    steps.push({ step: "backend", ok: true, note: "清单未声明 healthUrl，跳过" });
  }
  const bad = steps.filter((s) => s.ok === false);
  return { ok: !bad.length, steps, plugin: listPublic(true).find((x) => x.id === again.id) || null };
}
function stateText(s) {
  return (
    { normal: "正常", disabled: "已停用", incompatible: "与当前版本不兼容", error: "有错误" }[s] || String(s || "")
  );
}

/* ══════════════════════════ 导入 / 导出 ══════════════════════════ */

/* 极简 zip 读取：只用标准库解 deflate 的 stored / deflate 两种条目（够插件包用），
   并逐条挡路径穿越（.. / 绝对路径 / 盘符）—— 见 unzipInto。 */
function unzipEntries(buf) {
  const out = [];
  let i = 0;
  const n = buf.length;
  while (i + 30 <= n) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    let compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString("utf8");
    const dataStart = i + 30 + nameLen + extraLen;
    if (compSize === 0) {
      /* 数据描述符（流式写入的 zip）：本实现不支持，直接停 */
      break;
    }
    const data = buf.slice(dataStart, dataStart + compSize);
    i = dataStart + compSize;
    out.push({ name, method, data });
  }
  return out;
}
function unzipInto(buf, destDir) {
  const zlib = require("zlib");
  const entries = unzipEntries(buf);
  if (!entries.length) return { ok: false, error: "不是可识别的 zip（或不支持流式 zip）" };
  let n = 0;
  for (const e of entries) {
    const raw = String(e.name || "").replace(/\\/g, "/");
    if (!raw || raw.endsWith("/")) continue;
    const parts = raw.split("/").filter((x) => x && x !== ".");
    if (!parts.length || parts.some((x) => x === ".." || /^[A-Za-z]:$/.test(x))) continue;
    const dest = join(destDir, ...parts);
    const relToDest = path.relative(destDir, dest);
    if (relToDest.startsWith("..") || path.isAbsolute(relToDest)) continue;
    let data = e.data;
    try {
      if (e.method === 8) data = zlib.inflateRawSync(data);
      else if (e.method !== 0) continue;
    } catch {
      continue;
    }
    mk(path.dirname(dest));
    fs.writeFileSync(dest, data);
    n++;
  }
  if (!n) return { ok: false, error: "zip 里没有可用文件" };
  return { ok: true, files: n };
}

/** 导入一个插件（zip 或目录）：拷进 user-plugins/<id>/ → 重扫 → 应用 MCP / 技能 */
async function importPlugin(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  let srcPath = String(p.path || "");
  let buf = null;
  if (p.base64) {
    try {
      buf = Buffer.from(String(p.base64).replace(/\s+/g, ""), "base64");
    } catch (e) {
      return { ok: false, error: "zip 内容无法解码" };
    }
  }
  if (!srcPath && !buf) {
    /* 没给路径：弹系统选择框（目录或 zip） */
    const win = typeof getMainWin === "function" ? getMainWin() : null;
    const r = win
      ? dialog.showOpenDialogSync(win, {
          title: "选择插件目录或 .zip 包",
          properties: ["openFile", "openDirectory"],
          filters: [{ name: "插件包", extensions: ["zip"] }],
        })
      : dialog.showOpenDialogSync({
          title: "选择插件目录或 .zip 包",
          properties: ["openFile", "openDirectory"],
          filters: [{ name: "插件包", extensions: ["zip"] }],
        });
    if (!r || !r.length) return { ok: false, error: "cancelled" };
    srcPath = String(r[0]);
  }
  let isDir = false;
  let tmpDir = "";
  try {
    if (buf) {
      tmpDir = join(userPluginsRoot(), ".import-" + Date.now().toString(36));
      mk(tmpDir);
      const uz = unzipInto(buf, tmpDir);
      if (!uz.ok) {
        rmDir(tmpDir);
        return uz;
      }
      isDir = true;
      srcPath = tmpDir;
    } else {
      const st = fs.statSync(srcPath);
      isDir = st.isDirectory();
      if (!isDir) {
        const size = st.size;
        if (size > MAX_ZIP) return { ok: false, error: "zip 超过 " + Math.round(MAX_ZIP / 1048576) + "MB" };
        tmpDir = join(userPluginsRoot(), ".import-" + Date.now().toString(36));
        mk(tmpDir);
        const uz = unzipInto(fs.readFileSync(srcPath), tmpDir);
        if (!uz.ok) {
          rmDir(tmpDir);
          return uz;
        }
        isDir = true;
        srcPath = tmpDir;
      }
    }
    /* 目录里若只有一层同名子目录（zip 常见打包方式），下钻一层 */
    let srcRoot = srcPath;
    if (isDir && !findManifest(srcRoot)) {
      const subs = fs.readdirSync(srcRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
      const hit = subs.find((e) => findManifest(join(srcRoot, e.name)));
      if (hit) srcRoot = join(srcRoot, hit.name);
    }
    const manifestPath = findManifest(srcRoot);
    if (!manifestPath) {
      if (tmpDir) rmDir(tmpDir);
      return { ok: false, error: "包里找不到 " + MANIFEST_NAME };
    }
    const raw = readJson(manifestPath, null);
    const nz = normalizeManifest(raw, path.basename(srcRoot));
    if (!nz.doc || !nz.doc.id) {
      if (tmpDir) rmDir(tmpDir);
      return { ok: false, error: "清单缺少合法 id：" + (nz.errors || []).join("; ") };
    }
    const id = nz.doc.id;
    const dest = join(userPluginsRoot(), id);
    const existed = fs.existsSync(dest);
    if (existed && !p.overwrite) {
      if (tmpDir) rmDir(tmpDir);
      return { ok: false, error: "同名插件已存在：" + id, needOverwrite: true, id };
    }
    if (existed) rmDir(dest);
    if (tmpDir) {
      fs.renameSync(srcRoot, dest);
      /* tmpDir 里剩下的壳（同名子目录那层）清掉 */
      if (path.resolve(tmpDir) !== path.resolve(dest)) rmDir(tmpDir);
    } else {
      copyDirRecursive(srcRoot, dest);
    }
    scan();
    const again = pluginById(id);
    let ext = null;
    if (again && again.state === "normal") ext = applyMcpAndSkills(again);
    return {
      ok: true,
      id,
      replaced: existed,
      plugin: listPublic(true).find((x) => x.id === id) || null,
      ext,
    };
  } catch (e) {
    if (tmpDir) rmDir(tmpDir);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 诊断导出：清单原文 + 版本信息 + 体检结果 + 最近日志片段 → exports/user-plugin-diag-<ts>.json */
function exportDiagnostics(id) {
  const p = id ? pluginById(id) : null;
  const logsDir = join(getDataDir(), "logs");
  let logTail = "";
  try {
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => /\.log$/i.test(f))
      .map((f) => ({ f, m: fs.statSync(join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length) {
      const txt = readText(join(logsDir, files[0].f), 2 * 1024 * 1024);
      const lines = txt.split(/\r?\n/);
      logTail = lines
        .filter((l) => /user-plugins|plugin|插件/i.test(l))
        .slice(-200)
        .join("\n");
      if (!logTail) logTail = lines.slice(-200).join("\n");
    }
  } catch {}
  const doc = {
    kind: "mtnode-user-plugin-diagnostics",
    ver: 1,
    at: new Date().toISOString(),
    appVersion: appVersion(),
    platform: process.platform,
    root: userPluginsRoot(),
    plugin: p
      ? {
          id: p.id,
          version: p.version,
          state: p.state,
          dir: p.dir,
          errors: p.errors,
          warnings: p.warnings,
          manifestRaw: readJson(p.manifestPath, null),
          files: p.files,
        }
      : null,
    allPlugins: listPublic(false),
    health: healthReport({ quiet: true }),
    logTail,
  };
  const name = "user-plugin-diag-" + (p ? p.id + "-" : "") + Date.now() + ".json";
  const file = join(exportsDir(), name);
  writeJson(file, doc);
  /* 只留最近 20 份诊断包 */
  try {
    const all = fs
      .readdirSync(exportsDir())
      .filter((f) => /^user-plugin-diag-.*\.json$/.test(f))
      .map((f) => ({ f, m: fs.statSync(join(exportsDir(), f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const x of all.slice(EXPORT_KEEP)) {
      try {
        fs.unlinkSync(join(exportsDir(), x.f));
      } catch {}
    }
  } catch {}
  return { ok: true, path: file, bytes: (() => { try { return fs.statSync(file).size; } catch { return 0; } })() };
}

/* ══════════════════════════ 本机 HTTP（插件节点的 http 型调用） ══════════════════════════ */

/**
 * 主进程替插件节点发一次 HTTP。**只允许本机地址**（127.0.0.1 / localhost / ::1）：
 * 插件节点的语义是「调用户自己起的本机后端」，不允许拿它当任意外网代理。
 * 返回 { ok, status, json, text, headers }。
 */
function httpCall(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const raw = String(p.url || "").trim();
  if (!raw) return Promise.resolve({ ok: false, error: "缺少 url" });
  let u = null;
  try {
    u = new URL(raw);
  } catch {
    return Promise.resolve({ ok: false, error: "url 不合法：" + raw });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return Promise.resolve({ ok: false, error: "只支持 http(s)" });
  }
  if (!LOCAL_HOSTS.has(String(u.hostname || "").toLowerCase())) {
    return Promise.resolve({
      ok: false,
      error: "插件节点只允许调用本机地址（127.0.0.1 / localhost）：" + u.hostname,
    });
  }
  const method = String(p.method || "POST").toUpperCase();
  const bodyRaw = p.body == null ? "" : String(p.body);
  const headers = Object.assign({}, p.headers && typeof p.headers === "object" ? p.headers : {});
  if (bodyRaw && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  if (bodyRaw) headers["Content-Length"] = Buffer.byteLength(bodyRaw);
  const timeoutMs = Math.max(1000, Math.min(1800000, Number(p.timeoutMs) || 120000));
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let req = null;
    try {
      req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          let total = 0;
          res.on("data", (c) => {
            total += c.length;
            if (total > MAX_HTTP_BODY) {
              try {
                req.destroy();
              } catch {}
              finish({ ok: false, error: "响应超过 " + Math.round(MAX_HTTP_BODY / 1048576) + "MB" });
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const text = buf.toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            const ct = String((res.headers && res.headers["content-type"]) || "");
            const status = Number(res.statusCode) || 0;
            finish({
              ok: status >= 200 && status < 300,
              status,
              headers: res.headers || {},
              text,
              json,
              contentType: ct,
              /* 二进制图（png/jpg/webp）：交给渲染层落资产 */
              imageBase64:
                /^image\//i.test(ct) && buf.length <= MAX_HTTP_BODY ? buf.toString("base64") : "",
            });
          });
        },
      );
    } catch (e) {
      finish({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {}
      finish({ ok: false, error: "请求超时（" + timeoutMs + "ms）" });
    });
    req.on("error", (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    if (bodyRaw) req.write(bodyRaw);
    req.end();
  });
}

/* ══════════════════════════ 模板 / 启用停用 ══════════════════════════ */

const README_TEMPLATE = `# 我的 MTNode 插件

## 目录约定

\`\`\`
user-plugins/
  my-plugin/                 ← 文件夹名建议等于清单里的 id
    mtnode-plugin.json       ← 唯一必需的清单文件
    README.md                ← 可选：写给用户看的说明（后端怎么起、参数怎么填）
    skills/<技能名>/SKILL.md ← 可选：清单 skills 里声明的技能正文
\`\`\`

## 清单最小示例

\`\`\`json
{
  "id": "my-plugin",
  "version": "1.0.0",
  "minAppVersion": "1.5.0",
  "title": { "zh": "我的插件", "en": "My Plugin" },
  "subtitle": { "zh": "一句话说明", "en": "One line" },
  "nodes": [
    {
      "id": "summarize",
      "title": { "zh": "摘要", "en": "Summarize" },
      "inputs": [{ "id": "text", "kind": "text", "label": { "zh": "正文" } }],
      "outputs": [{ "id": "out", "kind": "text", "label": { "zh": "摘要" } }],
      "params": [
        { "id": "style", "type": "select", "label": { "zh": "风格" },
          "options": [{ "value": "short", "label": { "zh": "精简" } }], "default": "short" }
      ],
      "call": {
        "kind": "model",
        "prompt": "请用{param:style}的风格摘要下面的内容：\\n{input:text}",
        "output": "out"
      }
    }
  ]
}
\`\`\`

## 两种调用方式

- \`"kind": "model"\`：走 MTNode 已经配好的服务商与模型（节点上会带模型选择，默认跟随全局默认）。
- \`"kind": "http"\`：调**本机**后端（只允许 127.0.0.1 / localhost），配套字段见清单 \`backend\`。

模板占位符：\`{input:端口id}\`、\`{inputJson:端口id}\`、\`{text}\`（所有文本端口的汇总）、
\`{param:参数id}\`、\`{node:title}\`、\`{plugin:id}\`。

## 安全边界

插件目录里**不允许任何会被执行的 JS**：清单只是一份声明，能做的事就是「调模型 / 调本机 HTTP /
提供技能与 MCP 声明」。

## 版本兼容

- \`minAppVersion\` / \`maxAppVersion\`：可选的版本区间，缺省表示不限。
- 未知字段一律忽略，缺字段按默认补齐：老清单在应用升级后照旧能用。
`;

const EXAMPLE_MANIFEST = {
  id: "_example",
  version: "1.0.0",
  minAppVersion: "1.5.0",
  title: { zh: "示例插件（模板 · 可改名照抄）", en: "Example Plugin (template)" },
  subtitle: {
    zh: "一个模型类节点 + 一个本机 HTTP 类节点：把这份清单改一改就是你的插件。",
    en: "One model node + one local HTTP node: copy and edit this manifest.",
  },
  backend: {
    hint: {
      zh: "本插件不需要后端；HTTP 节点默认调用 http://127.0.0.1:8799/echo（可用任意本机服务替换，或用 python -m http.server 8799 起一个）。",
      en: "No backend needed; the HTTP node calls http://127.0.0.1:8799/echo by default.",
    },
    healthUrl: "http://127.0.0.1:8799/",
  },
  nodes: [
    {
      id: "polish",
      title: { zh: "示例 · 文本润色（模型）", en: "Example · Polish (model)" },
      desc: {
        zh: "把上游文本按指定语气润色；模型与提示词都在本插件清单里声明。",
        en: "Polish upstream text with a chosen tone.",
      },
      w: 260,
      h: 200,
      inputs: [{ id: "text", kind: "text", label: { zh: "原文", en: "Text" }, required: true }],
      outputs: [{ id: "out", kind: "text", label: { zh: "润色后", en: "Polished" } }],
      params: [
        {
          id: "tone",
          type: "select",
          label: { zh: "语气", en: "Tone" },
          options: [
            { value: "简洁", label: { zh: "简洁", en: "Concise" } },
            { value: "正式", label: { zh: "正式", en: "Formal" } },
            { value: "口语", label: { zh: "口语", en: "Casual" } },
          ],
          default: "简洁",
        },
        { id: "extra", type: "textarea", label: { zh: "额外要求", en: "Extra" }, placeholder: "可留空" },
      ],
      call: {
        kind: "model",
        system: "你是一位中文编辑，只输出润色后的正文，不要解释。",
        temperature: 0.7,
        prompt: "请用「{param:tone}」的语气润色下面的正文。{param:extra}\\n\\n{input:text}",
        output: "out",
      },
    },
    {
      id: "echo",
      title: { zh: "示例 · 本机接口（HTTP）", en: "Example · Local HTTP" },
      desc: {
        zh: "POST 到本机 127.0.0.1 的一个接口，把响应里的字段取出到出端口。",
        en: "POST to a local endpoint and pick fields from the JSON response.",
      },
      w: 260,
      h: 180,
      inputs: [{ id: "text", kind: "text", label: { zh: "输入文本", en: "Text" } }],
      outputs: [{ id: "out", kind: "text", label: { zh: "响应", en: "Response" } }],
      params: [{ id: "port", type: "number", label: { zh: "端口", en: "Port" }, default: 8799 }],
      call: {
        kind: "http",
        method: "POST",
        url: "http://127.0.0.1:{param:port}/echo",
        headers: { "Content-Type": "application/json" },
        body: "{\"text\": \"{input:text}\"}",
        timeoutMs: 30000,
        pick: { out: "echo" },
        output: "out",
      },
    },
  ],
  mcp: [],
  skills: [],
};

/** 首次运行：建好 user-plugins/ + `_example` 模板 + README */
function ensureTemplate() {
  const root = userPluginsRoot();
  const readme = join(root, "README.md");
  const exDir = join(root, TEMPLATE_DIR);
  const out = { ok: true, created: [] };
  try {
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, README_TEMPLATE, "utf8");
      out.created.push("README.md");
    }
    if (!fs.existsSync(exDir)) {
      mk(exDir);
      writeJson(join(exDir, MANIFEST_NAME), EXAMPLE_MANIFEST);
      fs.writeFileSync(join(exDir, "README.md"), README_TEMPLATE, "utf8");
      out.created.push(TEMPLATE_DIR + "/");
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), created: out.created };
  }
  return out;
}

function setDisabled(id, disabled) {
  const s = String(id || "");
  const p = pluginById(s);
  const key = p ? p.id : s;
  const st = stateOf();
  const set = new Set(st.disabled);
  if (disabled) set.add(key);
  else set.delete(key);
  st.disabled = [...set];
  writeState(st);
  /* 状态文件改完必须重扫：p 是**重扫前**取的对象，它的 state 还是旧值（启用后仍等于
     "disabled"），拿它去 applyMcpAndSkills 会被「状态不是 normal」挡掉 —— 技能就再也回不来。
     一律用重扫后的 fresh 对象。 */
  scan();
  const fresh = pluginById(key);
  /* 停用即从 dsh 侧撤掉它声明的 MCP / 技能（不影响别的插件） */
  if (disabled && fresh) removeMcpAndSkills(fresh);
  if (!disabled && fresh && fresh.state === "normal") applyMcpAndSkills(fresh);
  return { ok: true, plugins: listPublic(false) };
}
/** 撤掉某插件声明的 MCP 行与技能目录（只动带本插件来源标记的那些） */
function removeMcpAndSkills(plugin) {
  try {
    const cmpPath = join(getDataDir(), "dsh-home", "cordis-user.yml");
    if (fs.existsSync(cmpPath)) {
      const txt = readText(cmpPath, 2 * 1024 * 1024);
      const blocks = txt.split(/\n(?=- id: )/);
      const kept = blocks.filter((b) => {
        for (const m of plugin.mcp) {
          if (b.includes("serverName: '" + m.name + "'")) return false;
        }
        return true;
      });
      if (kept.length !== blocks.length) fs.writeFileSync(cmpPath, kept.join("\n"), "utf8");
    }
  } catch {}
  for (const s of plugin.skills) {
    try {
      const dir = join(getDataDir(), "dsh-home", "skills", s.name);
      const mark = join(dir, ".mtnode-user-plugin.json");
      if (fs.existsSync(mark)) rmDir(dir);
    } catch {}
  }
}

/* ══════════════════════════ IPC ══════════════════════════ */

function registerUserPluginsIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  getAppVersion = opts.getAppVersion;
  appRoot = String((opts && opts.appRoot) || appRoot || "");
  ipcMain.handle("userPlugins:list", (e, deep) => {
    if (!scanned.length) {
      ensureTemplate();
      scan();
    }
    return { ok: true, root: userPluginsRoot(), plugins: listPublic(!!deep), appVersion: appVersion() };
  });
  ipcMain.handle("userPlugins:rescan", () => {
    ensureTemplate();
    const list = scan();
    /* 每次重扫顺手把 MCP / 技能对齐一遍（幂等；用户手改过也会被补回来） */
    for (const p of list) {
      if (p.state === "normal" && (p.mcp.length || p.skills.length)) applyMcpAndSkills(p);
    }
    return { ok: true, plugins: listPublic(false), root: userPluginsRoot() };
  });
  ipcMain.handle("userPlugins:nodes", () => {
    if (!scanned.length) scan();
    return { ok: true, nodes: activeNodeDefs() };
  });
  ipcMain.handle("userPlugins:setEnabled", (e, id, disabled) => setDisabled(String(id || ""), !!disabled));
  ipcMain.handle("userPlugins:repair", (e, id) => repairPlugin(String(id || "")));
  ipcMain.handle("userPlugins:import", (e, payload) => importPlugin(payload));
  ipcMain.handle("userPlugins:export", (e, id) => exportDiagnostics(String(id || "")));
  ipcMain.handle("userPlugins:http", (e, payload) => httpCall(payload));
  ipcMain.handle("userPlugins:health", () => healthReport({ quiet: false }));
  ipcMain.handle("userPlugins:openFolder", (e, id) => {
    const p = id ? pluginById(String(id)) : null;
    const dir = p ? p.dir : userPluginsRoot();
    try {
      shell.openPath(dir);
      return { ok: true, dir };
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.message) || e2) };
    }
  });
  ipcMain.handle("userPlugins:relaunch", () => {
    setTimeout(() => {
      try {
        app.relaunch();
        app.exit(0);
      } catch {}
    }, 220);
    return { ok: true };
  });
}

module.exports = {
  registerUserPluginsIpc,
  runStartupHealth,
  scan,
  listPublic,
  activeNodeDefs,
  healthReport,
  ensureTemplate,
  userPluginsRoot,
  MANIFEST_NAME,
};

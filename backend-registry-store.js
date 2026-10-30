"use strict";
/**
 * 重后端注册中心 · 数据层（只碰磁盘，不碰进程 / 窗口）
 *
 * 定位（与插件体系并存、互不替代）：插件是官方功能的入口；这里管的是 Agent 在任务里
 * 现场装出来的工具 —— 装完登记一条，之后任何会话 / 画布都能查到并复用。
 * 与缺口文档 docs/text-to-video-pipeline-gap.md 的 G1 对应，但**不预置任何后端声明**。
 *
 * 一条登记（manifest）的硬字段（缺一项就拒绝登记，见 normalizeManifest）：
 *   id / name / kind(http|cli) / desc(工具描述) / args(参数表，可为空数组) /
 *   启动或调用命令（http 可以是 adopt.baseUrl 接管已在跑的服务；cli 必须给 cli.cmd）
 *
 * 数据落盘（全部在用户数据目录，绝不落应用目录 —— AGENTS.md）：
 *   <数据目录>/backend-registry/registry.json   条目真源（原子写）
 *   <数据目录>/backend-registry/audit.jsonl     全程留痕（谁 / 何时 / 装了什么 / 从哪装）
 *   <数据目录>/backend-registry/runtime/<id>.json  运行态（pid / 端口 / 状态）
 *   <数据目录>/backend-registry/logs/<id>.log    后端 stdout / stderr 环形日志
 */

const fs = require("fs");
const path = require("path");

const REG_SUBDIR = "backend-registry";
const ID_OK = /^[a-z0-9][a-z0-9._-]{0,47}$/i;
const KINDS = new Set(["http", "cli"]);
const ARG_KINDS = new Set(["text", "image", "audio", "video"]);
const LOCK_CLASSES = new Set(["gpu", "cpu", "none"]);
const SOURCES = new Set(["managed", "adopted"]);
const MAX_ARGS = 24;
const MAX_LOG_LINES = 300;

function s(v) {
  return v == null ? "" : String(v);
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function trimCmd(v) {
  return arr(v)
    .map((x) => s(x).trim())
    .filter(Boolean);
}

/** ASCII 工具名（Agent 侧调用名）：登记 id 里非 [A-Za-z0-9_] 一律换成 _，统一加 br_ 前缀。 */
function toolNameOf(id) {
  const slug = s(id)
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56);
  return "br_" + (slug || "tool");
}

/**
 * 校验 + 归一一条登记。返回 {ok:true, item} 或 {ok:false, error} —— error 是给人和 Agent 看的一句话。
 * 这里**故意严格**：Agent 自动登记时写错字段，宁可当场拒绝并说明，也不要收一条之后调不动的记录。
 */
function normalizeManifest(input, opts) {
  const o = opts || {};
  const raw = input && typeof input === "object" ? input : {};
  const id = s(raw.id).trim();
  if (!ID_OK.test(id)) return { ok: false, error: "id 非法：只能用字母 / 数字 / . _ -（1–48 字符），且以字母或数字开头" };
  const name = s(raw.name).trim();
  if (!name) return { ok: false, error: "缺少 name（工具显示名）" };
  const kind = s(raw.kind).trim().toLowerCase();
  if (!KINDS.has(kind)) return { ok: false, error: 'kind 只能是 "http"（常驻服务）或 "cli"（一次性命令行）' };
  const desc = s(raw.desc).trim();
  if (desc.length < 4) return { ok: false, error: "缺少 desc（给 Agent 看的工具描述，至少 4 个字）" };
  if (!Array.isArray(raw.args)) return { ok: false, error: "缺少 args（参数表；没有参数也要给空数组 []）" };
  if (raw.args.length > MAX_ARGS) return { ok: false, error: "args 太多（上限 " + MAX_ARGS + " 个参数）" };
  const args = [];
  const seen = new Set();
  for (let i = 0; i < raw.args.length; i++) {
    const a = raw.args[i] && typeof raw.args[i] === "object" ? raw.args[i] : {};
    const an = s(a.name).trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(an)) return { ok: false, error: "args[" + i + "].name 非法：只能用字母 / 数字 / . _ -" };
    if (seen.has(an)) return { ok: false, error: "args 里的参数名重复：" + an };
    seen.add(an);
    const ak = s(a.kind || "text").toLowerCase();
    if (!ARG_KINDS.has(ak)) return { ok: false, error: "args[" + i + "].kind 只能是 text / image / audio / video" };
    args.push({ name: an, kind: ak, required: a.required !== false, desc: s(a.desc).trim() });
  }
  const returns = arr(raw.returns).map((r) => ({
    name: s(r && r.name).trim() || "text",
    kind: ARG_KINDS.has(s(r && r.kind).toLowerCase()) ? s(r.kind).toLowerCase() : "text",
  }));
  const source = s(raw.source || "managed").toLowerCase();
  if (!SOURCES.has(source)) return { ok: false, error: 'source 只能是 "managed"（注册中心安装）或 "adopted"（接管本机已有）' };

  /* http：要么给 launch.cmd（由注册中心起进程），要么给 adopt.baseUrl（接管已在跑的服务） */
  let launch = null;
  let adopt = null;
  let cli = null;
  if (kind === "http") {
    const launchCmd = trimCmd(raw.launch && raw.launch.cmd);
    const baseUrl = s(raw.adopt && raw.adopt.baseUrl).trim();
    if (!launchCmd.length && !baseUrl) {
      return { ok: false, error: "kind=http 时必须给 launch.cmd（启动命令数组）或 adopt.baseUrl（接管已在跑的服务）" };
    }
    if (launchCmd.length) {
      const pr = arr(raw.launch && raw.launch.portRange).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
      const health = (raw.launch && raw.launch.health) || {};
      launch = {
        cmd: launchCmd,
        cwd: s(raw.launch && raw.launch.cwd).trim(),
        portRange: pr.length >= 2 ? [pr[0], pr[1]] : [17800, 17899],
        portFlag: s(raw.launch && raw.launch.portFlag).trim(),
        health: {
          path: s(health.path).trim() || "/health",
          timeoutSec: Math.max(5, Math.min(900, Number(health.timeoutSec) || 60)),
        },
        readyLine: s(raw.launch && raw.launch.readyLine).trim(),
        restartOnCrash: raw.launch && raw.launch.restartOnCrash === true,
        maxRestarts: Math.max(0, Math.min(9, Number(raw.launch && raw.launch.maxRestarts) || 3)),
      };
    } else {
      adopt = { baseUrl };
    }
    const call = (raw.call && typeof raw.call === "object" ? raw.call : {});
    return {
      ok: true,
      item: {
        ver: 1,
        id,
        name,
        kind,
        desc,
        args,
        returns: returns.length ? returns : [{ name: "text", kind: "text" }],
        source,
        launch,
        adopt,
        call: {
          method: s(call.method || "POST").toUpperCase() === "GET" ? "GET" : "POST",
          path: s(call.path).trim() || "/",
          timeoutSec: Math.max(5, Math.min(3600, Number(call.timeoutSec) || 600)),
        },
        lock: normLock(raw.lock),
        install: normInstall(raw.install),
        createdBy: s(o.actor || raw.createdBy || "user"),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Date.now(),
      },
    };
  }

  /* cli：一次性命令行工具；{name} 占位由宿主按参数值替换 */
  const cliCmd = trimCmd(raw.cli && raw.cli.cmd);
  if (!cliCmd.length) return { ok: false, error: "kind=cli 时必须给 cli.cmd（命令行数组，可含 {参数名} 占位）" };
  cli = {
    cmd: cliCmd,
    cwd: s(raw.cli && raw.cli.cwd).trim(),
    timeoutSec: Math.max(5, Math.min(3600, Number(raw.cli && raw.cli.timeoutSec) || 300)),
    shell: raw.cli && raw.cli.shell === true,
  };
  return {
    ok: true,
    item: {
      ver: 1,
      id,
      name,
      kind,
      desc,
      args,
      returns: returns.length ? returns : [{ name: "text", kind: "text" }],
      source,
      launch: null,
      adopt: null,
      call: null,
      cli,
      lock: normLock(raw.lock),
      install: normInstall(raw.install),
      createdBy: s(o.actor || raw.createdBy || "user"),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Date.now(),
    },
  };
}

function normLock(v) {
  const o = v && typeof v === "object" ? v : {};
  const cls = s(o.class || "cpu").toLowerCase();
  return { class: LOCK_CLASSES.has(cls) ? cls : "cpu", exclusive: o.exclusive !== false };
}

function normInstall(v) {
  const o = v && typeof v === "object" ? v : {};
  return {
    /* 注册中心自己创建 / 确认过的目录：卸载时勾选「删磁盘文件」只允许删这里面的东西 */
    dir: s(o.dir).trim(),
    sizeGB: Number(o.sizeGB) || 0,
    from: s(o.from).trim(),
    note: s(o.note).trim(),
  };
}

/** 给 Agent 的工具描述子（与 renderer/app-tools.js 的 lib / canvas 描述子同一形状）。 */
function descriptorOf(item) {
  if (!item) return null;
  return {
    key: "br:" + item.id,
    toolName: toolNameOf(item.id),
    name: item.name,
    description: item.desc,
    example: "",
    limits: "",
    atLeastOne: [],
    inputs: arr(item.args).map((a) => ({
      name: a.name,
      kind: a.kind,
      optional: a.required === false,
      description: a.desc,
    })),
    outputs: arr(item.returns).map((r) => ({ name: r.name, kind: r.kind })),
    origin: "backend",
    backendId: item.id,
  };
}

function createStore(opts) {
  const o = opts || {};
  const getDataDir = typeof o.getDataDir === "function" ? o.getDataDir : () => process.cwd();
  const log = typeof o.log === "function" ? o.log : () => {};
  const onChanged = typeof o.onChanged === "function" ? o.onChanged : () => {};
  let cache = null;

  function root() {
    const dir = path.join(getDataDir(), REG_SUBDIR);
    fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    return dir;
  }
  function registryPath() {
    return path.join(root(), "registry.json");
  }
  function auditPath() {
    return path.join(root(), "audit.jsonl");
  }
  function runtimePath(id) {
    return path.join(root(), "runtime", String(id) + ".json");
  }
  function logPath(id) {
    return path.join(root(), "logs", String(id) + ".log");
  }
  function readJson(p, dflt) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return dflt;
    }
  }
  function writeJsonAtomic(p, obj) {
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, p);
  }

  function load() {
    if (cache) return cache;
    const doc = readJson(registryPath(), null);
    const items = {};
    if (doc && doc.items && typeof doc.items === "object") {
      for (const [id, it] of Object.entries(doc.items)) {
        const n = normalizeManifest(Object.assign({ id }, it), { actor: it && it.createdBy });
        if (n.ok) items[id] = n.item;
      }
    }
    cache = { ver: 1, items };
    return cache;
  }
  function save() {
    writeJsonAtomic(registryPath(), load());
    onChanged();
  }

  function list() {
    return Object.values(load().items).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function get(id) {
    return load().items[s(id)] || null;
  }
  function descriptors() {
    return list().map(descriptorOf).filter(Boolean);
  }

  /** 登记 / 更新（同 id = 更新，保留 createdAt）。actor = "agent" | "user"。 */
  function upsert(input, actor) {
    const r = normalizeManifest(input, { actor });
    if (!r.ok) return r;
    const doc = load();
    const prev = doc.items[r.item.id];
    if (prev) r.item.createdAt = prev.createdAt || r.item.createdAt;
    doc.items[r.item.id] = r.item;
    save();
    audit({
      action: prev ? "update" : "register",
      id: r.item.id,
      actor: actor || r.item.createdBy,
      detail:
        (prev ? "更新登记：" : "登记新工具：") +
        r.item.name +
        " · " +
        r.item.kind +
        " · " +
        (r.item.source === "adopted" ? "接管" : "安装"),
    });
    return { ok: true, item: r.item };
  }

  function remove(id) {
    const doc = load();
    const it = doc.items[s(id)];
    if (!it) return { ok: false, error: "没有这条登记：" + s(id) };
    delete doc.items[id];
    save();
    audit({ action: "unregister", id: s(id), actor: "user", detail: "删除登记：" + it.name });
    return { ok: true, item: it };
  }

  /** 全程留痕：谁 / 何时 / 装了什么 / 从哪装。失败也要记（ok:false + error）。 */
  function audit(entry) {
    const e = entry && typeof entry === "object" ? entry : {};
    const line = {
      ts: Date.now(),
      action: s(e.action) || "unknown",
      id: s(e.id),
      actor: s(e.actor) || "system",
      ok: e.ok !== false,
      detail: s(e.detail),
      error: s(e.error),
    };
    try {
      fs.appendFileSync(auditPath(), JSON.stringify(line) + "\n", "utf8");
    } catch (err) {
      log("[backend-registry] audit write failed: " + ((err && err.message) || err));
    }
    return line;
  }

  function auditList(opts2) {
    const q = opts2 || {};
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 80));
    let lines = [];
    try {
      const txt = fs.readFileSync(auditPath(), "utf8");
      lines = txt.split("\n").filter(Boolean).slice(-4000);
    } catch {
      return [];
    }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let rec = null;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (q.id && s(rec.id) !== s(q.id)) continue;
      out.push(rec);
    }
    return out;
  }

  /* ── 运行态 / 日志 ── */
  function readRuntime(id) {
    return readJson(runtimePath(id), null);
  }
  function writeRuntime(id, rt) {
    try {
      writeJsonAtomic(runtimePath(id), rt || {});
    } catch (err) {
      log("[backend-registry] runtime write failed: " + ((err && err.message) || err));
    }
  }
  function clearRuntime(id) {
    try {
      fs.unlinkSync(runtimePath(id));
    } catch {}
  }
  function appendLog(id, text) {
    const line = s(text);
    if (!line) return;
    const p = logPath(id);
    let lines = [];
    try {
      lines = fs.readFileSync(p, "utf8").split("\n").filter((x) => x !== "");
    } catch {}
    for (const piece of line.split("\n")) if (piece !== "") lines.push(piece.slice(0, 2000));
    if (lines.length > MAX_LOG_LINES) lines = lines.slice(lines.length - MAX_LOG_LINES);
    try {
      fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
    } catch {}
  }
  function readLog(id, limit) {
    const n = Math.max(1, Math.min(MAX_LOG_LINES, Number(limit) || 120));
    try {
      const lines = fs.readFileSync(logPath(id), "utf8").split("\n").filter((x) => x !== "");
      return lines.slice(Math.max(0, lines.length - n)).join("\n");
    } catch {
      return "";
    }
  }
  function clearLog(id) {
    try {
      fs.unlinkSync(logPath(id));
    } catch {}
  }

  return {
    root,
    registryPath,
    auditPath,
    runtimePath,
    logPath,
    list,
    get,
    descriptors,
    upsert,
    remove,
    audit,
    auditList,
    readRuntime,
    writeRuntime,
    clearRuntime,
    appendLog,
    readLog,
    clearLog,
    invalidate() {
      cache = null;
    },
  };
}

module.exports = {
  REG_SUBDIR,
  createStore,
  normalizeManifest,
  descriptorOf,
  toolNameOf,
};

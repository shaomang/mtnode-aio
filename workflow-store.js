"use strict";

/* ── 主进程侧「工作流库」存储 ───────────────────────────────────────────
 * 工作流 = 一颗「节点层」（kind "super"）连同它的整棵子树：内部节点、内部连线、
 * 外侧端子桥接、封面。它**不是**一张画布：插入时只往当前画布上放一颗可展开的
 * 节点层，绝不打开新画布。
 *
 * 落盘：<数据目录>/workflows/<id>.json（每条一目；数据目录与画布 save/ 同一根，
 * 跟随「配置数据目录」迁移）。条目结构：
 *   {
 *     id, name, description, version: "1.0",
 *     cover: "<dataURL>" | "",              // 节点层封面（可选；透明背景建议）
 *     graph: { rootId, nodes:[...], wires:[...] },   // 单颗节点层的完整快照
 *     origin: { kind: "canvas" | "workshop", storeId, title },  // 来源（工坊下架不影响本机）
 *     createdAt, updatedAt
 *   }
 * 端口表不落盘：它由 graph 里的边界桥接连线**现算**（渲染层 workflowPortsFromGraph），
 * 与画布上节点层的端子是同一份真源，不存第二份。
 *
 * 与工坊互通的包装：.mtnodes 容器（与画布导出同一格式，魔数 / 版本 / gzip 清单），
 * 清单里的 workflow 是一张「只有这颗节点层」的最小画布（nodes + wires，无资产）。
 * 之所以在这里实现一份最小 pack/unpack：本模块由 main.js require，反向 require
 * main.js 会形成环；而工作流包不含资产（分享硬规则要求剥离本机路径），
 * 所以用不到 main.js 里的资产打包逻辑。
 * ─────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ipcMain } = require("electron");
const { readJson, writeJson } = require("./config-providers.js");

const WF_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const MTNODES_MAGIC = "MTNODES";
const MTNODES_VERSION = 1;
const MAX_PACK_BYTES = 10 * 1024 * 1024;

let getDataDir = () => "";
let t = (s) => String(s == null ? "" : s);

function workflowsRoot() {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("工作流库存储未初始化（缺少数据目录）"));
  return path.join(d, "workflows");
}
const wfPath = (id) => path.join(workflowsRoot(), String(id) + ".json");

function badArg(msg) {
  return { ok: false, error: msg };
}
function fail(err) {
  return { ok: false, error: String((err && err.message) || err) };
}
function genId() {
  return "wfl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ── 图快照归一 ────────────────────────────────────────────────────────
 * 只收「单颗节点层」：根 = 快照里唯一一颗父级不在快照内的 super；其余节点必须
 * 是它的后代（parentSuperId 链能走到根）。画布包（多根）一律拒收 —— 那是
 * 「导入画布」的活，不是工作流。 */
function normGraph(raw) {
  const g = raw && typeof raw === "object" ? raw : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const wires = Array.isArray(g.wires) ? g.wires : [];
  if (!nodes.length) return null;
  const byId = new Map();
  for (const n of nodes) {
    if (n && typeof n === "object" && n.id) byId.set(String(n.id), n);
  }
  if (!byId.size) return null;
  const inSet = (id) => byId.has(String(id || ""));
  const roots = nodes.filter((n) => {
    const p = String((n && n.parentSuperId) || "");
    return !p || !inSet(p);
  });
  /* 根必须是节点层；若快照里还混着别的根（整张画布），只认第一个节点层并拒收其余
     非后代节点 —— 明确报错比悄悄丢节点安全。 */
  const superRoots = roots.filter((n) => n && n.kind === "super");
  if (!superRoots.length) return null;
  const wantRoot = String(g.rootId || "");
  const root =
    superRoots.find((n) => String(n.id) === wantRoot) || superRoots[0];
  const keep = new Set([String(root.id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      const id = String((n && n.id) || "");
      if (keep.has(id)) continue;
      if (keep.has(String((n && n.parentSuperId) || ""))) {
        keep.add(id);
        grew = true;
      }
    }
  }
  const keptNodes = nodes.filter((n) => n && keep.has(String(n.id)));
  if (keptNodes.length !== nodes.length) {
    /* 快照里有落单的节点：说明它不是「一颗节点层」的完整子树 */
    return { extra: nodes.length - keptNodes.length };
  }
  const keptWires = wires.filter(
    (w) => w && keep.has(String(w.from)) && keep.has(String(w.to)),
  );
  return { rootId: String(root.id), nodes: keptNodes, wires: keptWires, extra: 0 };
}

/* 轻量清单条目（列表不回 graph / cover：封面是最大 512KB 的 dataURL） */
function listEntry(j) {
  const g = j.graph && typeof j.graph === "object" ? j.graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const root = nodes.find((n) => n && String(n.id) === String(g.rootId || "")) || null;
  return {
    id: String(j.id || ""),
    name: String(j.name || ""),
    description: String(j.description || ""),
    version: String(j.version || "1.0"),
    hasCover: !!j.cover,
    nodeCount: nodes.length,
    wireCount: Array.isArray(g.wires) ? g.wires.length : 0,
    origin: j.origin && typeof j.origin === "object" ? j.origin : null,
    createdAt: Number(j.createdAt) || 0,
    updatedAt: Number(j.updatedAt) || 0,
    rootTitle: root ? String(root.title || "") : "",
  };
}

function listWorkflows() {
  const root = workflowsRoot();
  let names = [];
  try {
    names = fs
      .readdirSync(root)
      .filter((f) => f.endsWith(".json") && WF_ID_RE.test(f.slice(0, -5)));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const j = readJson(path.join(root, f), null);
      if (!j || typeof j !== "object") continue;
      out.push(listEntry(j));
    } catch {}
  }
  out.sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
  );
  return out;
}

function readWorkflow(id) {
  const p = wfPath(id);
  if (!fs.existsSync(p)) return null;
  const j = readJson(p, null);
  return j && typeof j === "object" ? j : null;
}

/* ── .mtnodes 最小打包 / 解包（仅工作流包：无资产段）──────────────────── */
function packWorkflow(graph, name) {
  const wf = {
    name: String(name || ""),
    nodes: graph.nodes,
    wires: graph.wires,
    marks: [],
    groups: [],
  };
  const manifest = {
    format: "mtnodes",
    version: MTNODES_VERSION,
    app: "MTNode",
    exportedAt: new Date().toISOString(),
    workflowName: wf.name,
    workflow: wf,
    assets: [],
  };
  const manifestBuf = zlib.gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(manifestBuf.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(0, 0);
  return Buffer.concat([
    Buffer.from(MTNODES_MAGIC, "ascii"),
    Buffer.from([MTNODES_VERSION]),
    head,
    manifestBuf,
    count,
  ]);
}

function unpackWorkflow(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8)
    throw new Error(t("文件太小，不是有效的工作流包"));
  if (buf.slice(0, 7).toString("ascii") !== MTNODES_MAGIC)
    throw new Error(t("不是有效的 .mtnodes 工作流包"));
  const version = buf[7];
  if (version !== MTNODES_VERSION)
    throw new Error(t("不支持的工作流包版本：") + version);
  let off = 8;
  const ml = buf.readUInt32LE(off);
  off += 4;
  if (off + ml > buf.length) throw new Error(t("工作流包已损坏（清单越界）"));
  const manifest = JSON.parse(
    zlib.gunzipSync(buf.slice(off, off + ml)).toString("utf8"),
  );
  if (!manifest || manifest.format !== "mtnodes")
    throw new Error(t("不是有效的 .mtnodes 工作流包"));
  return manifest;
}

function registerWorkflowsIpc(opts) {
  opts = opts || {};
  if (typeof opts.getDataDir === "function") getDataDir = opts.getDataDir;
  if (typeof opts.t === "function") t = opts.t;

  ipcMain.handle("workflows:list", () => {
    try {
      return { ok: true, workflows: listWorkflows() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("workflows:get", (e, id) => {
    if (!WF_ID_RE.test(String(id || ""))) return badArg(t("非法工作流 id"));
    try {
      const j = readWorkflow(String(id));
      return j ? { ok: true, workflow: j } : { ok: false, error: t("工作流不存在") };
    } catch (err) {
      return fail(err);
    }
  });

  /* 保存（新增或覆盖）：同名由渲染层先查后确认覆盖，这里只按 id 落盘；
     无 id / id 不存在 → 生成新 id */
  ipcMain.handle("workflows:save", (e, pkg) => {
    try {
      if (pkg == null || typeof pkg !== "object")
        return badArg(t("工作流格式错误"));
      const name = String(pkg.name == null ? "" : pkg.name).trim();
      if (!name) return badArg(t("工作流名不能为空"));
      const g = normGraph(pkg.graph);
      if (!g) return badArg(t("工作流里必须恰好有一颗节点层"));
      if (g.extra) return badArg(t("节点层之外还有节点，无法保存为工作流"));
      const now = Date.now();
      let id = String(pkg.id || "").trim();
      const next = {
        id: id,
        name: name,
        description: String(pkg.description || ""),
        version: String(pkg.version || "1.0").slice(0, 20),
        cover: typeof pkg.cover === "string" ? pkg.cover : "",
        graph: { rootId: g.rootId, nodes: g.nodes, wires: g.wires },
        origin:
          pkg.origin && typeof pkg.origin === "object"
            ? {
                kind: String(pkg.origin.kind || "canvas"),
                storeId: String(pkg.origin.storeId || ""),
                title: String(pkg.origin.title || ""),
              }
            : { kind: "canvas", storeId: "", title: "" },
        createdAt: now,
        updatedAt: now,
      };
      const prev = id && WF_ID_RE.test(id) ? readWorkflow(id) : null;
      if (prev) {
        next.createdAt = Number(prev.createdAt) || now;
        /* 未显式给封面时保留原封面（改名 / 覆盖保存不该丢封面） */
        if (typeof pkg.cover !== "string") next.cover = String(prev.cover || "");
        if (!pkg.origin && prev.origin) next.origin = prev.origin;
      } else {
        id = genId();
        next.id = id;
      }
      writeJson(wfPath(id), next);
      return { ok: true, id: id };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("workflows:delete", (e, id) => {
    if (!WF_ID_RE.test(String(id || ""))) return badArg(t("非法工作流 id"));
    try {
      const p = wfPath(String(id));
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  /* 改名 / 改描述 / 改版本 */
  ipcMain.handle("workflows:patch", (e, arg) => {
    const id = arg && arg.id;
    const patch = (arg && arg.patch) || {};
    if (!WF_ID_RE.test(String(id || ""))) return badArg(t("非法工作流 id"));
    try {
      const j = readWorkflow(String(id));
      if (!j) return { ok: false, error: t("工作流不存在") };
      if (typeof patch.name === "string") {
        const name = patch.name.trim();
        if (!name) return badArg(t("工作流名不能为空"));
        j.name = name;
      }
      if (typeof patch.description === "string") j.description = patch.description;
      if (typeof patch.version === "string")
        j.version = patch.version.trim().slice(0, 20) || "1.0";
      if (typeof patch.cover === "string") j.cover = patch.cover;
      j.updatedAt = Date.now();
      writeJson(wfPath(String(id)), j);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  /* 导出为工坊用的 .mtnodes base64。第二个参数是渲染层已经剥干净本机路径 / 依赖的
     图快照（分享必须用剥离后的副本，本机库里那份原样保留）；不给就用库里的。 */
  ipcMain.handle("workflows:exportBase64", (e, id, graphOverride) => {
    if (!WF_ID_RE.test(String(id || ""))) return badArg(t("非法工作流 id"));
    try {
      const j = readWorkflow(String(id));
      if (!j) return { ok: false, error: t("工作流不存在") };
      const src =
        graphOverride && typeof graphOverride === "object" && Array.isArray(graphOverride.nodes)
          ? graphOverride
          : j.graph;
      const g = normGraph(src);
      if (!g || g.extra) return badArg(t("工作流内容已损坏（不是单颗节点层）"));
      const buf = packWorkflow(g, j.name);
      if (buf.length > MAX_PACK_BYTES)
        return badArg(t("工作流包超过 10MB，无法分享"));
      return {
        ok: true,
        name: String(j.name || ""),
        description: String(j.description || ""),
        version: String(j.version || "1.0"),
        bytes: buf.length,
        base64: buf.toString("base64"),
      };
    } catch (err) {
      return fail(err);
    }
  });

  /* 从 .mtnodes base64 收进本机库（工坊下载 / 别人发来的包）。不改画布。 */
  ipcMain.handle("workflows:importBase64", (e, arg) => {
    const base64 = String((arg && arg.base64) || "");
    if (!base64) return badArg(t("工作流包为空"));
    try {
      let buf;
      try {
        buf = Buffer.from(base64, "base64");
      } catch (_) {
        return badArg(t("工作流包内容无效"));
      }
      if (!buf.length) return badArg(t("工作流包内容无效"));
      if (buf.length > MAX_PACK_BYTES) return badArg(t("工作流包超过 10MB"));
      const manifest = unpackWorkflow(buf);
      const g = normGraph(manifest.workflow);
      if (!g) return badArg(t("工作流包里没有节点层"));
      if (g.extra) return badArg(t("工作流包里除了节点层还有别的节点，无法收录"));
      const now = Date.now();
      const id = genId();
      const name =
        String((arg && arg.name) || manifest.workflowName || "").trim() ||
        t("未命名工作流");
      const next = {
        id: id,
        name: name,
        description: String((arg && arg.description) || ""),
        version: String((arg && arg.version) || "1.0").slice(0, 20),
        cover: typeof (arg && arg.cover) === "string" ? arg.cover : "",
        graph: { rootId: g.rootId, nodes: g.nodes, wires: g.wires },
        origin: {
          kind: "workshop",
          storeId: String((arg && arg.storeId) || ""),
          title: String((arg && arg.title) || ""),
        },
        createdAt: now,
        updatedAt: now,
      };
      writeJson(wfPath(id), next);
      return { ok: true, id: id, name: name, nodeCount: g.nodes.length };
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { registerWorkflowsIpc };

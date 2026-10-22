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
 *     artifacts: [ { nodeId, nodeTitle, role, name, rel, bytes, sha1, descHash } ],
 *     origin: { kind: "canvas" | "workshop", storeId, title },  // 来源（工坊下架不影响本机）
 *     createdAt, updatedAt
 *   }
 * 端口表不落盘：它由 graph 里的边界桥接连线**现算**（渲染层 workflowPortsFromGraph），
 * 与画布上节点层的端子是同一份真源，不存第二份。
 *
 * ── 中间产物（artifacts）──────────────────────────────────────────────
 * 需要 Agent 跑才能产出的中间文件（典型：remotion 的 Composition.tsx、智能节点在
 * 工作目录里写出的 .tsx/.json/.md）必须随工作流一起走，否则换台机器 / 换个人插入
 * 后只能重新生成，出现「同一颗工作流两种表现」。口径：
 *   · 保存到工作流库时就收集（扩展名白名单，全局一份规则，见 readArtifactRules）；
 *   · 文件本体落 <数据目录>/assets/<条目 id>/artifacts/<nodeId>/<相对名>，
 *     条目里只记清单（nodeId / role / name / bytes / sha1 / descHash）；
 *   · 分享时随 .mtnodes 的尾部「文件段」一起打包（正文里的本机绝对路径先清洗）；
 *   · 插入画布 / 从工坊导入时复制到 <数据目录>/assets/<画布 id>/artifacts/…，
 *     并把节点上的路径改写成新的绝对路径。
 * descHash = 保存那一刻节点「描述文本」的指纹（各 kind 取自己的描述字段）：运行时
 * 用它判断包内产物是否还配得上当前描述 —— 配得上就直接复用，不重调 LLM。
 *
 * 与工坊互通的包装：.mtnodes 容器（与画布导出同一格式，魔数 / 版本 / gzip 清单 +
 * 尾部文件段）。画布包的文件段装 assets，工作流包装 artifacts；容器结构完全同构，
 * 所以这里实现一份最小 pack/unpack（老包没有文件段，按空处理）。
 * ─────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { ipcMain } = require("electron");
const { readJson, writeJson } = require("./config-providers.js");

const WF_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const MTNODES_MAGIC = "MTNODES";
const MTNODES_VERSION = 1;
const MAX_PACK_BYTES = 10 * 1024 * 1024;

/* 中间产物：默认白名单 / 上限（用户可在「工作流库 → 中间产物规则」里增删扩展名） */
const ARTIFACT_DEFAULT_EXT = [
  "tsx", "ts", "js", "jsx", "mjs", "cjs", "json", "md", "vue", "svelte",
  "py", "css", "scss", "html", "txt", "yml", "yaml", "glsl", "wgsl", "sql",
];
/* 正文按文本处理（分享时清洗本机绝对路径）的扩展名 */
const ARTIFACT_TEXT_EXT = new Set([
  "tsx", "ts", "js", "jsx", "mjs", "cjs", "json", "md", "vue", "svelte",
  "py", "css", "scss", "html", "txt", "yml", "yaml", "glsl", "wgsl", "sql",
]);
const ARTIFACT_MAX_TOTAL = 64 * 1024 * 1024;
const ARTIFACT_MAX_FILE = 8 * 1024 * 1024;
const ARTIFACT_MAX_FILES = 200;
const ARTIFACT_SCAN_DEPTH = 3;
const ARTIFACT_SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", "dist", "dist_check", "build", "out",
  ".next", ".nuxt", ".cache", ".dsh-probe", "venv", ".venv", "__pycache__",
  ".idea", ".vscode",
]);

let getDataDir = () => "";
let t = (s) => String(s == null ? "" : s);

function workflowsRoot() {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("工作流库存储未初始化（缺少数据目录）"));
  return path.join(d, "workflows");
}
const wfPath = (id) => path.join(workflowsRoot(), String(id) + ".json");

/* 中间产物本体目录：与画布资产目录同一根（<数据目录>/assets/<id>/artifacts），
   库条目 id 与画布 id 共用这一套路径规则。 */
function artifactDirOf(id) {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("工作流库存储未初始化（缺少数据目录）"));
  return path.join(d, "assets", String(id), "artifacts");
}

function badArg(msg) {
  return { ok: false, error: msg };
}
function fail(err) {
  return { ok: false, error: String((err && err.message) || err) };
}
function genId() {
  return "wfl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}
function extOf(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p || ""));
  return m ? m[1].toLowerCase() : "";
}

/* ── 中间产物规则（全局一份）────────────────────────────────────────── */
function rulesPath() {
  return path.join(String(getDataDir() || "").trim(), "workflow-artifact-rules.json");
}
function readArtifactRules() {
  let raw = null;
  try {
    raw = readJson(rulesPath(), null);
  } catch {}
  const ext = Array.isArray(raw && raw.ext)
    ? raw.ext
        .map((x) => String(x || "").trim().toLowerCase().replace(/^\./, ""))
        .filter(Boolean)
    : ARTIFACT_DEFAULT_EXT.slice();
  const maxTotalBytes = Number(raw && raw.maxTotalBytes);
  const maxFileBytes = Number(raw && raw.maxFileBytes);
  return {
    ext: ext.length ? [...new Set(ext)] : ARTIFACT_DEFAULT_EXT.slice(),
    maxTotalBytes:
      isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : ARTIFACT_MAX_TOTAL,
    maxFileBytes:
      isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : ARTIFACT_MAX_FILE,
    defaults: { ext: ARTIFACT_DEFAULT_EXT.slice() },
  };
}
function writeArtifactRules(patch) {
  const cur = readArtifactRules();
  const next = {
    ext: cur.ext,
    maxTotalBytes: cur.maxTotalBytes,
    maxFileBytes: cur.maxFileBytes,
  };
  if (patch && Array.isArray(patch.ext)) {
    const ext = patch.ext
      .map((x) => String(x || "").trim().toLowerCase().replace(/^\./, ""))
      .filter((x) => /^[a-z0-9+_-]{1,16}$/.test(x));
    next.ext = [...new Set(ext)];
  }
  for (const k of ["maxTotalBytes", "maxFileBytes"]) {
    const v = Number(patch && patch[k]);
    if (isFinite(v) && v > 0) next[k] = Math.floor(v);
  }
  writeJson(rulesPath(), next);
  return readArtifactRules();
}

/* 节点的工作目录（智能任务用 workspace，其余用 agentWorkspace；两者都可能为空 =
   跟随画布统一目录，那种情况渲染层运行时才知道，保存时按节点自己填的字段为准）。 */
function workspaceOf(n) {
  if (!n || typeof n !== "object") return "";
  const raw =
    n.kind === "agent_task" ? n.workspace || n.agentWorkspace : n.agentWorkspace || n.workspace;
  const s = String(raw || "").trim();
  return s && path.isAbsolute(s) ? s : "";
}

/* 节点「描述文本」：各 kind 取自己那个字段，与渲染层 nodeDescriptionText 同一口径 */
function nodeDescText(n) {
  if (!n || typeof n !== "object") return "";
  const cand = [n.text, n.task, n.prompt, n.goal, n.description];
  for (const c of cand) {
    const s = String(c == null ? "" : c).trim();
    if (s) return s;
  }
  return "";
}
function descHashOf(n) {
  const s = nodeDescText(n).replace(/\s+/g, " ").trim();
  return s ? descHashOfText(s) : "";
}
/* 描述指纹：FNV-1a 32 位（渲染层 wfArtifactDescHash 用同一算法，两边必须逐位一致，
   所以要的是「可复现」而不是密码学强度）。 */
function descHashOfText(s) {
  const buf = Buffer.from(String(s || ""), "utf8");
  let h = 0x811c9dc5;
  for (const b of buf) {
    h ^= b;
    /* 必须用 Math.imul（32 位乘法）：普通 * 会在 2^53 之后丢精度，与渲染层的
       同一算法算出两个不同的值。 */
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/* remotion：包内产物的「角色」= tsx（渲染时直接作为 src/Composition.tsx） */
function roleOf(n, name) {
  if (n && n.kind === "remotion" && /\.tsx?$/i.test(String(name || ""))) return "tsx";
  return "artifact";
}

/* 收集一颗节点层里所有节点的中间产物（只读，不写盘）。
 * 返回 { items:[{nodeId,nodeTitle,role,name,bytes,sha1,descHash,data}], warnings, totalBytes }
 * 超过单文件 / 总量上限的一律跳过并记 warning（不阻断保存，用户可在规则里放宽）。 */
function collectArtifacts(graph) {
  const g = graph && typeof graph === "object" ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const rules = readArtifactRules();
  const extSet = new Set(rules.ext);
  const seenAbs = new Set();
  const items = [];
  const warnings = [];
  let total = 0;
  let count = 0;

  const push = (it) => {
    if (count >= ARTIFACT_MAX_FILES) {
      warnings.push({ nodeId: it.nodeId, name: it.name, reason: "too_many" });
      return;
    }
    if (it.data.length > rules.maxFileBytes) {
      warnings.push({ nodeId: it.nodeId, name: it.name, reason: "file_too_big" });
      return;
    }
    if (total + it.data.length > rules.maxTotalBytes) {
      warnings.push({ nodeId: it.nodeId, name: it.name, reason: "over_total" });
      return;
    }
    total += it.data.length;
    count++;
    items.push(it);
  };

  for (const n of nodes) {
    if (!n || typeof n !== "object" || !n.id) continue;
    const nodeId = String(n.id);
    const nodeTitle = String(n.title || "");
    const descHash = descHashOf(n);
    let found = 0;
    const ws = workspaceOf(n);
    const walk = (dir, rel, depth, skipNames) => {
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        if (skipNames && skipNames.has(ent.name.toLowerCase())) continue;
        const abs = path.join(dir, ent.name);
        const relName = rel ? rel + "/" + ent.name : ent.name;
        if (ent.isDirectory()) {
          if (depth >= ARTIFACT_SCAN_DEPTH) continue;
          if (ARTIFACT_SKIP_DIRS.has(ent.name.toLowerCase())) continue;
          walk(abs, relName, depth + 1, skipNames);
          continue;
        }
        if (!ent.isFile()) continue;
        if (!extSet.has(extOf(ent.name))) continue;
        if (seenAbs.has(abs)) continue;
        let data = null;
        try {
          const st = fs.statSync(abs);
          if (!st.isFile() || st.size > rules.maxFileBytes) {
            warnings.push({ nodeId, name: relName, reason: "file_too_big" });
            continue;
          }
          data = fs.readFileSync(abs);
        } catch {
          continue;
        }
        seenAbs.add(abs);
        found++;
        push({
          nodeId,
          nodeTitle,
          role: roleOf(n, relName),
          name: relName,
          bytes: data.length,
          sha1: sha1(data),
          descHash,
          data,
        });
      }
    };
    if (ws) walk(ws, "", 0);
    /* remotion：合成代码与渲染工程住在画布工作目录的 .mtnode/remotion/<节点 id>/ 里
       （见 remotion/main-remotion.js projectDirFor）。节点记着那个目录时一并收集 ——
       .mtnode 是隐藏目录，按工作目录根扫的默认深度 / 跳过目录规则扫不到它。
       render.json 是每次渲染重写的本机清单（含绝对路径），不进包：只带走合成代码。 */
    const remotionProjectDir =
      n.kind === "remotion" ? String(n.remotionProjectDir || "").trim() : "";
    if (remotionProjectDir && path.isAbsolute(remotionProjectDir))
      walk(remotionProjectDir, "", 0, new Set(["render.json"]));
    /* remotion：节点字段里已有合成代码（LLM 产出的 node.tsx 或用户直出代码）时，
       即使工作目录里没有对应文件，也要把这份代码作为包内产物带走 —— 这是最典型的
       「重构后表现不一致」来源（重新生成一次代码就变了）。 */
    if (n.kind === "remotion" && !found) {
      const code = String(n.tsxTsx || n.tsx || "").trim();
      if (code) {
        const data = Buffer.from(code, "utf8");
        push({
          nodeId,
          nodeTitle,
          role: "tsx",
          name: "Composition.tsx",
          bytes: data.length,
          sha1: sha1(data),
          descHash,
          data,
        });
      }
    }
  }
  return { items, warnings, totalBytes: total };
}

/* 把收集到的产物写进某个 id 的产物目录（库条目 id / 画布 id 同一套路径），
   返回清单（含 rel 与绝对 path）。
   opts.merge = true 时只覆盖同节点同名的文件、不清空整个目录 —— 一张画布上可能有
   多颗节点层，各自保存时不能把别人那份产物清掉。 */
function writeArtifactsFor(id, items, opts) {
  const merge = !!(opts && opts.merge);
  const root = artifactDirOf(id);
  if (!merge) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  fs.mkdirSync(root, { recursive: true });
  const out = [];
  for (const it of items) {
    const safeName = String(it.name || "")
      .split(/[\\/]+/)
      .filter((p) => p && p !== "." && p !== "..")
      .join("/");
    if (!safeName) continue;
    const nodeId = String(it.nodeId || "node").replace(/[^\w.-]/g, "_");
    const rel = nodeId + "/" + safeName;
    const dest = path.join(root, nodeId, safeName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.writeFileSync(dest, it.data);
    } catch {
      continue;
    }
    out.push({
      nodeId: String(it.nodeId || ""),
      nodeTitle: String(it.nodeTitle || ""),
      role: String(it.role || "artifact"),
      name: it.name,
      rel,
      bytes: it.data.length,
      sha1: it.sha1,
      descHash: String(it.descHash || ""),
      path: dest,
    });
  }
  return out;
}

/* 清单 → 打包用文件（分享 / 导出）：从库里的产物目录读回本体 */
function readArtifactBlobs(id, entries) {
  const root = artifactDirOf(id);
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const rel = String(e.rel || "");
    if (!rel) continue;
    const abs = path.join(
      root,
      ...rel.split("/").filter((p) => p && p !== "." && p !== ".."),
    );
    let data = null;
    try {
      data = fs.readFileSync(abs);
    } catch {
      continue;
    }
    out.push({ entry: e, data });
  }
  return out;
}

/* 分享前的正文清洗：文本类产物里的本机绝对路径换成本文件名（与节点字段同一口径） */
function isTextArtifact(name) {
  return ARTIFACT_TEXT_EXT.has(extOf(name));
}
function scrubAbsPathsInText(s) {
  const tail = (m) => {
    const parts = String(m).split(/[\\/]+/).filter(Boolean);
    return "./" + (parts.length ? parts[parts.length - 1] : "file");
  };
  return String(s || "")
    .replace(/[A-Za-z]:\\[^\s"'`<>|)]*/g, tail)
    .replace(/\\\\[^\s"'`<>|)]*/g, tail)
    .replace(/\/(?:home|root|Users|mnt|opt|content|data|srv)\/[^\s"'`<>|)]*/g, tail);
}
function scrubArtifactData(name, data) {
  if (!isTextArtifact(name)) return data;
  try {
    return Buffer.from(scrubAbsPathsInText(data.toString("utf8")), "utf8");
  } catch {
    return data;
  }
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
  const root = superRoots.find((n) => String(n.id) === wantRoot) || superRoots[0];
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
  const arts = Array.isArray(j.artifacts) ? j.artifacts : [];
  return {
    id: String(j.id || ""),
    name: String(j.name || ""),
    description: String(j.description || ""),
    version: String(j.version || "1.0"),
    hasCover: !!j.cover,
    nodeCount: nodes.length,
    wireCount: Array.isArray(g.wires) ? g.wires.length : 0,
    artifactCount: arts.length,
    artifactBytes: arts.reduce((s, a) => s + (Number(a && a.bytes) || 0), 0),
    origin: j.origin && typeof j.origin === "object" ? j.origin : null,
    createdAt: Number(j.createdAt) || 0,
    updatedAt: Number(j.updatedAt) || 0,
    rootTitle: root ? String(root.title || "") : "",
    artifacts: arts.map((a) => ({
      nodeId: String(a.nodeId || ""),
      nodeTitle: String(a.nodeTitle || ""),
      role: String(a.role || "artifact"),
      name: String(a.name || ""),
      bytes: Number(a.bytes) || 0,
      sha1: String(a.sha1 || ""),
      descHash: String(a.descHash || ""),
    })),
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

/* ── .mtnodes 最小打包 / 解包（工作流包：清单 + 尾部文件段）──────────────
 * 容器与画布导出完全同构：
 *   魔数(7) + 版本(1) + 清单长度(4) + gzip(清单) + 文件数(4) + 逐文件
 *   [名长(4) + 名 + 数据长(4) + 数据]
 * 画布包的文件段装 assets；工作流包的文件段装中间产物（清单 artifacts[] 与之
 * 按 key = "@artifact/<i>" 对齐）。 */
function packWorkflow(graph, name, artifactBlobs, opts) {
  const scrub = !!(opts && opts.scrub);
  const wf = {
    name: String(name || ""),
    nodes: graph.nodes,
    wires: graph.wires,
    marks: [],
    groups: [],
  };
  const files = [];
  const artifacts = [];
  (Array.isArray(artifactBlobs) ? artifactBlobs : []).forEach((b) => {
    const key = "@artifact/" + files.length;
    const data = scrub ? scrubArtifactData(b.entry.name, b.data) : b.data;
    files.push({ name: key, bytes: data });
    artifacts.push({
      key,
      nodeId: String(b.entry.nodeId || ""),
      nodeTitle: String(b.entry.nodeTitle || ""),
      role: String(b.entry.role || "artifact"),
      name: String(b.entry.name || ""),
      rel: String(b.entry.rel || ""),
      bytes: data.length,
      sha1: sha1(data),
      descHash: String(b.entry.descHash || ""),
    });
  });
  const manifest = {
    format: "mtnodes",
    version: MTNODES_VERSION,
    app: "MTNode",
    exportedAt: new Date().toISOString(),
    workflowName: wf.name,
    workflow: wf,
    assets: [],
    artifacts,
  };
  const manifestBuf = zlib.gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(manifestBuf.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(files.length, 0);
  const chunks = [
    Buffer.from(MTNODES_MAGIC, "ascii"),
    Buffer.from([MTNODES_VERSION]),
    head,
    manifestBuf,
    count,
  ];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const nl = Buffer.alloc(4);
    nl.writeUInt32LE(nameBuf.length, 0);
    const dl = Buffer.alloc(4);
    dl.writeUInt32LE(f.bytes.length, 0);
    chunks.push(nl, nameBuf, dl, f.bytes);
  }
  return Buffer.concat(chunks);
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
  off += ml;
  /* 尾部文件段（可选：老包没有这一段，按空处理） */
  const files = [];
  if (off + 4 <= buf.length) {
    const n = buf.readUInt32LE(off);
    off += 4;
    for (let i = 0; i < n; i++) {
      if (off + 4 > buf.length) throw new Error(t("工作流包已损坏（文件段越界）"));
      const nl = buf.readUInt32LE(off);
      off += 4;
      if (off + nl > buf.length) throw new Error(t("工作流包已损坏（文件名越界）"));
      const name = buf.slice(off, off + nl).toString("utf8");
      off += nl;
      if (off + 4 > buf.length) throw new Error(t("工作流包已损坏（文件段越界）"));
      const dl = buf.readUInt32LE(off);
      off += 4;
      if (off + dl > buf.length) throw new Error(t("工作流包已损坏（文件数据越界）"));
      files.push({ name, data: buf.slice(off, off + dl) });
      off += dl;
    }
  }
  return { manifest, files };
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

  /* 中间产物规则（全局一份）：扩展名白名单 + 体积上限 */
  ipcMain.handle("workflows:artifactRules", (e, patch) => {
    try {
      if (patch && typeof patch === "object")
        return { ok: true, rules: writeArtifactRules(patch) };
      return { ok: true, rules: readArtifactRules() };
    } catch (err) {
      return fail(err);
    }
  });

  /* 收集预览（保存前看一眼会带哪些文件）：只读，不写盘 */
  ipcMain.handle("workflows:artifactsPreview", (e, graph) => {
    try {
      const g = normGraph(graph);
      if (!g || g.extra) return badArg(t("工作流里必须恰好有一颗节点层"));
      const r = collectArtifacts(g);
      return {
        ok: true,
        artifacts: r.items.map((it) => ({
          nodeId: it.nodeId,
          nodeTitle: it.nodeTitle,
          role: it.role,
          name: it.name,
          bytes: it.bytes,
          sha1: it.sha1,
          descHash: it.descHash,
        })),
        warnings: r.warnings,
        totalBytes: r.totalBytes,
      };
    } catch (err) {
      return fail(err);
    }
  });

  /* 保存（新增或覆盖）：同名由渲染层先查后确认覆盖，这里只按 id 落盘；
     无 id / id 不存在 → 生成新 id。
     pkg.canvasId 非空时，同时把产物复制一份到该画布的产物目录，让当前画布上的
     节点也指向包内那一份（本机插入与跨机导入表现一致）。 */
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
      const prev = id && WF_ID_RE.test(id) ? readWorkflow(id) : null;
      if (!prev) id = genId();
      /* 收集中间产物：按节点工作目录 + 白名单（remotion 的合成代码也从节点字段带走） */
      const collected = collectArtifacts(g);
      const stored = writeArtifactsFor(id, collected.items);
      /* 当前画布也放一份：节点上的路径改写到画布产物目录（渲染层据此回写 node.artifacts） */
      const canvasId = String(pkg.canvasId || "").trim();
      let canvasArtifacts = [];
      if (canvasId && canvasId !== id)
        canvasArtifacts = writeArtifactsFor(canvasId, collected.items, { merge: true });
      const next = {
        id: id,
        name: name,
        description: String(pkg.description || ""),
        version: String(pkg.version || "1.0").slice(0, 20),
        cover: typeof pkg.cover === "string" ? pkg.cover : "",
        graph: { rootId: g.rootId, nodes: g.nodes, wires: g.wires },
        artifacts: stored.map((s) => ({
          nodeId: s.nodeId,
          nodeTitle: s.nodeTitle,
          role: s.role,
          name: s.name,
          rel: s.rel,
          bytes: s.bytes,
          sha1: s.sha1,
          descHash: s.descHash,
        })),
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
      if (prev) {
        next.createdAt = Number(prev.createdAt) || now;
        /* 未显式给封面时保留原封面（改名 / 覆盖保存不该丢封面） */
        if (typeof pkg.cover !== "string") next.cover = String(prev.cover || "");
        if (!pkg.origin && prev.origin) next.origin = prev.origin;
      }
      writeJson(wfPath(id), next);
      return {
        ok: true,
        id: id,
        artifacts: stored,
        canvasArtifacts: canvasArtifacts,
        warnings: collected.warnings,
        artifactBytes: collected.totalBytes,
      };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("workflows:delete", (e, id) => {
    if (!WF_ID_RE.test(String(id || ""))) return badArg(t("非法工作流 id"));
    try {
      const p = wfPath(String(id));
      if (fs.existsSync(p)) fs.unlinkSync(p);
      try {
        fs.rmSync(artifactDirOf(String(id)), { recursive: true, force: true });
      } catch {}
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

  /* 把库条目里的产物复制到目标画布（插入 / 从工坊下载后插入时用）：
     返回 { byNode: { 原节点 id: [{ name, role, path, bytes, sha1, descHash }] } }，
     渲染层据此给克隆出来的新节点写 artifacts（用新旧 id 映射换键）。 */
  ipcMain.handle("workflows:artifactsMaterialize", (e, arg) => {
    const wfId = String((arg && arg.workflowId) || "");
    const canvasId = String((arg && arg.canvasId) || "");
    if (!WF_ID_RE.test(wfId)) return badArg(t("非法工作流 id"));
    if (!canvasId) return badArg(t("缺少目标画布"));
    try {
      const j = readWorkflow(wfId);
      if (!j) return { ok: false, error: t("工作流不存在") };
      const entries = Array.isArray(j.artifacts) ? j.artifacts : [];
      if (!entries.length) return { ok: true, byNode: {}, count: 0 };
      const blobs = readArtifactBlobs(wfId, entries);
      const items = blobs.map((b) => ({
        nodeId: b.entry.nodeId,
        nodeTitle: b.entry.nodeTitle,
        role: b.entry.role,
        name: b.entry.name,
        bytes: b.data.length,
        sha1: sha1(b.data),
        descHash: b.entry.descHash,
        data: b.data,
      }));
      const stored = writeArtifactsFor(canvasId, items);
      const byNode = {};
      for (const s of stored) {
        (byNode[s.nodeId] = byNode[s.nodeId] || []).push({
          name: s.name,
          role: s.role,
          path: s.path,
          bytes: s.bytes,
          sha1: s.sha1,
          descHash: s.descHash,
        });
      }
      return { ok: true, byNode, count: stored.length };
    } catch (err) {
      return fail(err);
    }
  });

  /* 写一份新的中间产物（运行时重生成后落盘）：目标画布产物目录，不覆盖库条目那份 */
  ipcMain.handle("workflows:artifactWrite", (e, arg) => {
    const canvasId = String((arg && arg.canvasId) || "");
    const nodeId = String((arg && arg.nodeId) || "");
    const name = String((arg && arg.name) || "artifact.tsx");
    const content = arg && typeof arg.content === "string" ? arg.content : "";
    if (!canvasId || !nodeId) return badArg(t("缺少画布或节点 id"));
    if (!content) return badArg(t("产物内容为空"));
    const data = Buffer.from(content, "utf8");
    const rules = readArtifactRules();
    if (data.length > rules.maxFileBytes)
      return badArg(
        t("产物超过单文件上限（") +
          Math.round(rules.maxFileBytes / 1024 / 1024) +
          "MB）",
      );
    try {
      const root = artifactDirOf(canvasId);
      const clip = (v) => String(v || "").replace(/[^\w.-]/g, "_");
      const safe = String(name)
        .split(/[\\/]+/)
        .filter((p) => p && p !== "." && p !== "..")
        .join("/");
      const dest = path.join(root, clip(nodeId), safe || "artifact.txt");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      return {
        ok: true,
        path: dest,
        name: safe || "artifact.txt",
        bytes: data.length,
        sha1: sha1(data),
      };
    } catch (err) {
      return fail(err);
    }
  });

  /* 导出为工坊用的 .mtnodes base64。第二个参数是渲染层已经剥干净本机路径 / 依赖的
     图快照（分享必须用剥离后的副本，本机库里那份原样保留）；不给就用库里的。
     中间产物按库条目里那份打包，文本类正文会先清洗本机绝对路径。 */
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
      const entries = Array.isArray(j.artifacts) ? j.artifacts : [];
      const blobs = readArtifactBlobs(id, entries);
      const rules = readArtifactRules();
      const total = blobs.reduce((s, b) => s + b.data.length, 0);
      if (total > rules.maxTotalBytes)
        return badArg(
          t("中间产物超过总量上限（") +
            Math.round(rules.maxTotalBytes / 1024 / 1024) +
            "MB），请先清理",
        );
      const buf = packWorkflow(g, j.name, blobs, { scrub: true });
      if (buf.length > MAX_PACK_BYTES)
        return badArg(t("工作流包超过 10MB，无法分享"));
      return {
        ok: true,
        name: String(j.name || ""),
        description: String(j.description || ""),
        version: String(j.version || "1.0"),
        bytes: buf.length,
        artifactCount: blobs.length,
        base64: buf.toString("base64"),
      };
    } catch (err) {
      return fail(err);
    }
  });

  /* 从 .mtnodes base64 收进本机库（工坊下载 / 别人发来的包）。不改画布。
     包里的中间产物落到库条目的产物目录（assets/<新 id>/artifacts/…），
     并把清单写回节点（path 为新的绝对路径，origin = workshop）。 */
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
      const { manifest, files } = unpackWorkflow(buf);
      const g = normGraph(manifest.workflow);
      if (!g) return badArg(t("工作流包里没有节点层"));
      if (g.extra) return badArg(t("工作流包里除了节点层还有别的节点，无法收录"));
      const now = Date.now();
      const id = genId();
      const name =
        String((arg && arg.name) || manifest.workflowName || "").trim() ||
        t("未命名工作流");
      /* 包内产物：清单 artifacts[] 与文件段按 key 对齐 */
      const declared = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
      const items = [];
      for (let i = 0; i < files.length; i++) {
        const meta =
          declared.find((d) => d && d.key === files[i].name) || declared[i] || null;
        if (!meta) continue;
        items.push({
          nodeId: String(meta.nodeId || ""),
          nodeTitle: String(meta.nodeTitle || ""),
          role: String(meta.role || "artifact"),
          name: String(meta.name || files[i].name),
          bytes: files[i].data.length,
          sha1: sha1(files[i].data),
          descHash: String(meta.descHash || ""),
          data: files[i].data,
        });
      }
      const stored = writeArtifactsFor(id, items);
      const byNode = new Map();
      for (const s of stored) {
        if (!byNode.has(s.nodeId)) byNode.set(s.nodeId, []);
        byNode.get(s.nodeId).push({
          name: s.name,
          role: s.role,
          path: s.path,
          bytes: s.bytes,
          sha1: s.sha1,
          descHash: s.descHash,
          origin: "workshop",
        });
      }
      const nodes = g.nodes.map((n) => {
        const cp = Object.assign({}, n);
        const list = byNode.get(String(n && n.id));
        if (list && list.length) cp.artifacts = list;
        return cp;
      });
      const next = {
        id: id,
        name: name,
        description: String((arg && arg.description) || ""),
        version: String((arg && arg.version) || "1.0").slice(0, 20),
        cover: typeof (arg && arg.cover) === "string" ? arg.cover : "",
        graph: { rootId: g.rootId, nodes: nodes, wires: g.wires },
        artifacts: stored.map((s) => ({
          nodeId: s.nodeId,
          nodeTitle: s.nodeTitle,
          role: s.role,
          name: s.name,
          rel: s.rel,
          bytes: s.bytes,
          sha1: s.sha1,
          descHash: s.descHash,
        })),
        origin: {
          kind: "workshop",
          storeId: String((arg && arg.storeId) || ""),
          title: String((arg && arg.title) || ""),
        },
        createdAt: now,
        updatedAt: now,
      };
      writeJson(wfPath(id), next);
      return {
        ok: true,
        id: id,
        name: name,
        nodeCount: g.nodes.length,
        artifactCount: stored.length,
      };
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { registerWorkflowsIpc };

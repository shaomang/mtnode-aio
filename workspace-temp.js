/* ── 工作目录临时文件：统计 + 清理（顶栏「工作目录占用与清理」/ 设置里的同名入口）──────
 *
 * 为什么单开一层：用户的工作目录（画布顶栏「工作目录」）里会积累应用自己写的中间物 ——
 *   · .mtnode/remotion/<节点 id>/   渲染工程的源码、render.json、public 素材副本、
 *                                   verify 校验片、.remotion 旧缓存与 out 成片
 *   · .mtnode-input/                会话与开发会话粘贴 / 截图的落盘图
 *   · recordings/                   现场录制（用户产物，默认不预勾）
 *   · 其它 . 开头的隐藏目录         只列出、默认不预勾（可能是用户自己的缓存）
 * 这些都不属于画布数据，删了只会让下次跑节点重新生成；但一跑几个月就是几个 GB。
 * 设置里的「存储占用与清理」统计的是**数据目录**（storage-clean.js），口径不同，
 * 所以两边各管一处，界面共用本模块这一个面板（不重做两套 UI）。
 *
 * 三条硬纪律（与 AGENTS.md 一致）：
 *   1. 只读 / 只删「本模块扫出来的可清理项」：clean 会先重新扫一遍，用扫出来的
 *      key 集合当白名单 —— 渲染层传来任何其它路径一律拒绝，绝不按传入路径直删。
 *   2. 删除一律走系统回收站（shell.trashItem，可在资源管理器还原），删不掉的文件
 *      汇总报告，不中断整次清理。
 *   3. 正在渲染的 remotion 节点目录跳过（媒体全局锁里有它的 nodeId），
 *      24 小时内改动过的项、其它画布的节点目录、成片（out/）都不预勾。
 *
 * 扫描结果形状（渲染层只消费它）：
 *   { ok, workspace, totalBytes, totalFiles, excluded:[名字], groups:[
 *       { id, label, rel, bytes, files, items:[
 *           { key, name, kind:"dir"|"file", bytes, files, mtime, category,
 *             scope:"current"|"other"|"orphan", owner, running, locked,
 *             checkable, defaultChecked, note, children:[同形状的叶子] } ] } ] }
 *   children 只在父项可展开时给（.mtnode/remotion/<id> 的子项是真正可勾的叶子；
 *   其它父项的子项只用于看明细，自己也可作整目录删除的单元 —— 见各组构造处）。
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { ipcMain, shell } = require("electron");
const { loadLock, lockIsLive } = require("./media-gen-global-lock.js");

/* 一律不进扫描结果的名字：版本库 / 依赖目录。用户选了「连 . 开头的其它隐藏目录也扫」，
   但这几类删了就是毁仓库或要重装依赖，硬排除。 */
const EXCLUDE_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "dist_check",
  ".dsh-probe",
  ".commandcode",
]);

/* 工作目录根部按名字识别的固定目录（其余 . 开头的目录按「其它隐藏目录」处理） */
const FIXED_DIRS = [".mtnode", ".mtnode-input", "recordings"];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHILDREN = 300; /* 一个父项最多列这么多子项，超出的只计体积 */

/* 一个 remotion 节点目录里各类子项的清理口径：mid = 中间产物（可预勾）
   out = 成片（必须手动勾）、other = 不认识的（绝不预勾） */
const NODE_SUB = [
  { name: "src", category: "source", label: "工程源码", mid: true },
  { name: "render.json", category: "config", label: "渲染配置", mid: true },
  { name: "public", category: "assets", label: "素材副本", mid: true },
  { name: "verify", category: "verify", label: "校验片", mid: true },
  { name: ".remotion", category: "cache", label: "旧浏览器缓存", mid: true },
  { name: "out", category: "output", label: "成片", mid: false },
];

function tr(t, s) {
  try {
    return typeof t === "function" ? t(s) : s;
  } catch {
    return s;
  }
}

function toAbs(ws, rel) {
  return path.join(ws, String(rel).split("/").join(path.sep));
}

function relOf(ws, abs) {
  return path.relative(ws, abs).split(path.sep).join("/");
}

function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 递归统计体积 / 文件数 / 最新 mtime：跳过符号链接与 EXCLUDE_NAMES，绝不抛 */
async function walk(p) {
  const out = { bytes: 0, files: 0, mtime: 0 };
  let st = null;
  try {
    st = await fsp.lstat(p);
  } catch {
    return out;
  }
  if (st.isSymbolicLink()) return out;
  out.mtime = st.mtimeMs || 0;
  if (st.isFile()) {
    out.bytes = st.size || 0;
    out.files = 1;
    return out;
  }
  if (!st.isDirectory()) return out;
  let ents = [];
  try {
    ents = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of ents) {
    if (EXCLUDE_NAMES.has(String(ent.name).toLowerCase())) continue;
    const sub = await walk(path.join(p, ent.name));
    out.bytes += sub.bytes;
    out.files += sub.files;
    if (sub.mtime > out.mtime) out.mtime = sub.mtime;
  }
  return out;
}

/** 节点归属索引：nodeId → [{ wfId, wfName, title }]（读数据目录 save/*.json） */
async function canvasNodeIndex(getDataDir) {
  const byNode = new Map();
  let dir = "";
  try {
    dir = path.join(getDataDir(), "save");
  } catch {
    return byNode;
  }
  let ents = [];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return byNode;
  }
  for (const ent of ents) {
    if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue;
    let j = null;
    try {
      j = JSON.parse(await fsp.readFile(path.join(dir, ent.name), "utf8"));
    } catch {
      continue;
    }
    if (!j || typeof j !== "object") continue;
    const wfId = String(j.id || ent.name.replace(/\.json$/i, ""));
    const wfName = String(j.name || wfId);
    const nodes = Array.isArray(j.nodes) ? j.nodes : [];
    for (const n of nodes) {
      if (!n || !n.id) continue;
      const id = String(n.id);
      let list = byNode.get(id);
      if (!list) byNode.set(id, (list = []));
      list.push({ wfId, wfName, title: String(n.title || id) });
    }
  }
  return byNode;
}

/** 正在渲染的 remotion 节点：媒体全局锁活着且 host=remotion 时，它就是那一个 */
function runningNodeId() {
  try {
    const lock = loadLock();
    if (!lock) return "";
    if (String(lock.host || "") !== "remotion") return "";
    return lockIsLive(lock) ? String(lock.nodeId || "") : "";
  } catch {
    return "";
  }
}

function ownerLabel(rec) {
  if (!rec || !rec.length) return "";
  return rec[0].wfName || rec[0].wfId || "";
}

/** 一个 remotion 节点目录 → 可勾选的叶子（源码 / 配置 / 素材 / 校验片 / 缓存 / 成片 / 其它） */
async function nodeLeaves(nodeDir, relBase, ctx, scope) {
  let ents = [];
  try {
    ents = await fsp.readdir(nodeDir, { withFileTypes: true });
  } catch {
    ents = [];
  }
  const byName = new Map(ents.map((e) => [e.name, e]));
  const leaves = [];
  const used = new Set();
  for (const spec of NODE_SUB) {
    const ent = byName.get(spec.name);
    if (!ent) continue;
    used.add(spec.name);
    const abs = path.join(nodeDir, spec.name);
    const size = await walk(abs);
    const key = relBase + "/" + spec.name;
    leaves.push({
      key,
      name: spec.name,
      kind: ent.isDirectory() ? "dir" : "file",
      bytes: size.bytes,
      files: size.files,
      mtime: size.mtime,
      category: spec.category,
      scope,
      owner: ctx.owner,
      running: ctx.running,
      locked: ctx.running,
      checkable: true,
      defaultChecked:
        !ctx.running && spec.mid && scope !== "other" && ctx.now - size.mtime >= DAY_MS,
      note: spec.category === "output" ? "成片默认不清理：清了要重新渲染才能再拿到" : "",
      children: [],
    });
  }
  /* 不认识的子项：保留、绝不预勾（可能是用户自己塞进工程目录的东西） */
  for (const ent of ents) {
    if (used.has(ent.name)) continue;
    const abs = path.join(nodeDir, ent.name);
    const size = await walk(abs);
    leaves.push({
      key: relBase + "/" + ent.name,
      name: ent.name,
      kind: ent.isDirectory() ? "dir" : "file",
      bytes: size.bytes,
      files: size.files,
      mtime: size.mtime,
      category: "other",
      scope,
      owner: ctx.owner,
      running: ctx.running,
      locked: ctx.running,
      checkable: true,
      defaultChecked: false,
      note: "",
      children: [],
    });
  }
  return leaves;
}

/** 生成一个父项：children 可勾（.mtnode/remotion/<id>）或只读明细（其它目录） */
function parentItem(o) {
  const bytes = (o.children || []).reduce((a, c) => a + (c.bytes || 0), 0);
  const files = (o.children || []).reduce((a, c) => a + (c.files || 0), 0);
  return {
    key: o.key,
    name: o.name,
    kind: "dir",
    bytes,
    files,
    mtime: o.mtime || 0,
    category: o.category || "dir",
    scope: o.scope || "current",
    owner: o.owner || "",
    running: !!o.running,
    locked: !!o.running,
    checkable: false,
    defaultChecked: false,
    note: o.note || "",
    childrenCheckable: !!o.childrenCheckable,
    children: o.children || [],
  };
}

async function scanWorkspace({ workspace, currentWfId, getDataDir, t }) {
  const ws = String(workspace || "").trim();
  if (!ws) return { ok: false, error: tr(t, "这张画布还没有工作目录：先在顶栏「工作目录」选一个文件夹") };
  let st = null;
  try {
    st = await fsp.stat(ws);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory())
    return { ok: false, error: tr(t, "工作目录不存在或不是有效文件夹：请重新选择后再统计") };

  const now = Date.now();
  const index = await canvasNodeIndex(getDataDir);
  const running = runningNodeId();
  const excluded = [];
  const groups = [];
  let totalBytes = 0;
  let totalFiles = 0;

  const groupOf = (id, label, rel) => {
    const g = { id, label, rel, bytes: 0, files: 0, items: [] };
    groups.push(g);
    return g;
  };
  const pushGroup = (g) => {
    totalBytes += g.bytes;
    totalFiles += g.files;
  };  const settleGroup = (g) => {
    g.bytes = g.items.reduce((a, it) => a + it.bytes, 0);
    g.files = g.items.reduce((a, it) => a + it.files, 0);
    pushGroup(g);
  };

  /* 工作目录根：先列一遍名字（用来找隐藏目录与 EXCLUDE 命中，不递归扫整棵树） */
  let rootEnts = [];
  try {
    rootEnts = await fsp.readdir(ws, { withFileTypes: true });
  } catch {
    rootEnts = [];
  }
  const rootDirs = rootEnts.filter((e) => e.isDirectory());
  /* 工作目录根上一眼就能看见的排除项（.git / node_modules …）：点了名才提示得清楚 */
  for (const ent of rootDirs) {
    if (EXCLUDE_NAMES.has(ent.name.toLowerCase()) && excluded.indexOf(ent.name) < 0)
      excluded.push(ent.name);
  }
  const hiddenDirs = rootDirs
    .map((e) => e.name)
    .filter((n) => n.startsWith(".") && FIXED_DIRS.indexOf(n) < 0)
    .filter((n) => !EXCLUDE_NAMES.has(n.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  /* ── ① .mtnode：remotion 工程（按节点一行）+ 其它子项 ────────────────── */
  {
    const abs = path.join(ws, ".mtnode");
    if (isDirSync(abs)) {
      const g = groupOf("mtnode", ".mtnode", ".mtnode");
      let ents = [];
      try {
        ents = await fsp.readdir(abs, { withFileTypes: true });
      } catch {
        ents = [];
      }
      const remotion = ents.find((e) => e.name === "remotion" && e.isDirectory());
      if (remotion) {
        const remAbs = path.join(abs, "remotion");
        let nodeEnts = [];
        try {
          nodeEnts = await fsp.readdir(remAbs, { withFileTypes: true });
        } catch {
          nodeEnts = [];
        }
        for (const ent of nodeEnts.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!ent.isDirectory()) continue;
          const nodeAbs = path.join(remAbs, ent.name);
          const rec = index.get(ent.name) || [];
          let scope = "orphan";
          if (rec.some((r) => r.wfId === currentWfId)) scope = "current";
          else if (rec.length) scope = "other";
          const isRunning = !!running && running === ent.name;
          const relBase = ".mtnode/remotion/" + ent.name;
          const ctx = { owner: ownerLabel(rec), running: isRunning, now };
          const children = await nodeLeaves(nodeAbs, relBase, ctx, scope);
          const nodeSize = await walk(nodeAbs);
          g.items.push(
            parentItem({
              key: relBase,
              name: ent.name,
              mtime: nodeSize.mtime,
              scope,
              owner: ownerLabel(rec),
              running: isRunning,
              category: "node",
              childrenCheckable: true,
              note: isRunning
                ? tr(t, "正在渲染：这一项不会出现在待清理列表里")
                : scope === "other"
                  ? tr(t, "属于其它画布，默认不勾选")
                  : scope === "orphan"
                    ? tr(t, "已经没有对应节点")
                    : "",
              children,
            }),
          );
        }
      }
      for (const ent of ents) {
        if (ent.name === "remotion") continue;
        const childAbs = path.join(abs, ent.name);
        const size = await walk(childAbs);
        g.items.push({
          key: ".mtnode/" + ent.name,
          name: ent.name,
          kind: ent.isDirectory() ? "dir" : "file",
          bytes: size.bytes,
          files: size.files,
          mtime: size.mtime,
          category: "other",
          scope: "current",
          owner: "",
          running: false,
          locked: false,
          checkable: true,
          defaultChecked: false,
          note: "",
          children: [],
        });
      }
      settleGroup(g);
    }
  }

  /* ── ② .mtnode-input：粘贴图 / 截图（全部算临时物） ────────────────────── */
  {
    const abs = path.join(ws, ".mtnode-input");
    if (isDirSync(abs)) {
      const g = groupOf("mtnode-input", ".mtnode-input", ".mtnode-input");
      let ents = [];
      try {
        ents = await fsp.readdir(abs, { withFileTypes: true });
      } catch {
        ents = [];
      }
      for (const ent of ents.slice(0, MAX_CHILDREN)) {
        const childAbs = path.join(abs, ent.name);
        const size = await walk(childAbs);
        g.items.push({
          key: ".mtnode-input/" + ent.name,
          name: ent.name,
          kind: ent.isDirectory() ? "dir" : "file",
          bytes: size.bytes,
          files: size.files,
          mtime: size.mtime,
          category: "input",
          scope: "current",
          owner: "",
          running: false,
          locked: false,
          checkable: true,
          defaultChecked: now - size.mtime >= DAY_MS,
          note: "",
          children: [],
        });
      }
      settleGroup(g);
    }
  }

  /* ── ③ recordings：用户产物，列出来但一律不预勾 ────────────────────────── */
  {
    const abs = path.join(ws, "recordings");
    if (isDirSync(abs)) {
      const g = groupOf("recordings", "recordings", "recordings");
      let ents = [];
      try {
        ents = await fsp.readdir(abs, { withFileTypes: true });
      } catch {
        ents = [];
      }
      for (const ent of ents.slice(0, MAX_CHILDREN)) {
        const childAbs = path.join(abs, ent.name);
        const size = await walk(childAbs);
        g.items.push({
          key: "recordings/" + ent.name,
          name: ent.name,
          kind: ent.isDirectory() ? "dir" : "file",
          bytes: size.bytes,
          files: size.files,
          mtime: size.mtime,
          category: "user",
          scope: "current",
          owner: "",
          running: false,
          locked: false,
          checkable: true,
          defaultChecked: false,
          note: tr(t, "录音是用户产物，默认不勾选"),
          children: [],
        });
      }
      settleGroup(g);
    }
  }

  /* ── ④ 其它 . 开头的隐藏目录：只列出、一律不预勾 ────────────────────────── */
  for (const name of hiddenDirs) {
    const abs = path.join(ws, name);
    const g = groupOf("hidden:" + name, name, name);
    const size = await walk(abs);
    let ents = [];
    try {
      ents = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      ents = [];
    }
    const children = [];
    for (const ent of ents.slice(0, MAX_CHILDREN)) {
      const childAbs = path.join(abs, ent.name);
      const s2 = await walk(childAbs);
      children.push({
        key: name + "/" + ent.name,
        name: ent.name,
        kind: ent.isDirectory() ? "dir" : "file",
        bytes: s2.bytes,
        files: s2.files,
        mtime: s2.mtime,
        category: "hidden",
        scope: "current",
        owner: "",
        running: false,
        locked: false,
        checkable: false,
        defaultChecked: false,
        note: "",
        children: [],
      });
    }
    g.items.push({
      key: name,
      name,
      kind: "dir",
      bytes: size.bytes,
      files: size.files,
      mtime: size.mtime,
      category: "hidden",
      scope: "current",
      owner: "",
      running: false,
      locked: false,
      checkable: true,
      defaultChecked: false,
      note: tr(t, "不是 MTNode 建的目录：只统计，默认不勾选"),
      childrenCheckable: false,
      children,
    });
    settleGroup(g);
  }

  return {
    ok: true,
    workspace: ws,
    totalBytes,
    totalFiles,
    excluded,
    groups: groups.filter((g) => g.items.length > 0),
  };
}

/** 收集扫描结果里所有「允许清理」的 key（运行中 / 锁住的项不算） */
function collectAllowedKeys(groups) {
  const out = new Map(); /* key → 字节 */
  const visit = (it) => {
    if (!it) return;
    if (it.childrenCheckable) {
      /* 父项本身不可勾，叶子才是清理单元（.mtnode/remotion/<节点>） */
      for (const c of it.children || []) {
        if (c.checkable && !c.running && !c.locked) out.set(c.key, c.bytes || 0);
      }
      return;
    }
    if (it.checkable && !it.running && !it.locked) out.set(it.key, it.bytes || 0);
  };
  for (const g of groups || []) for (const it of g.items || []) visit(it);
  return out;
}

function keyOk(ws, key) {
  const rel = String(key || "").replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return false;
  if (rel.split("/").some((seg) => !seg || seg === "." || seg === "..")) return false;
  const abs = toAbs(ws, rel);
  const back = path.relative(ws, abs);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) return false;
  return true;
}

async function cleanWorkspace({ workspace, keys, currentWfId, getDataDir, t }) {
  const ws = String(workspace || "").trim();
  const want = Array.isArray(keys) ? keys.map((k) => String(k || "").trim()).filter(Boolean) : [];
  if (!want.length) return { ok: true, removed: [], failed: [], freedBytes: 0 };
  /* 白名单 = 重新扫一遍得到的可清理项：渲染层传什么都不能越过它 */
  const fresh = await scanWorkspace({ workspace: ws, currentWfId, getDataDir, t });
  if (!fresh.ok) return { ok: false, error: fresh.error };
  const allowed = collectAllowedKeys(fresh.groups);
  const removed = [];
  const failed = [];
  let freedBytes = 0;
  const seen = new Set();
  for (const key of want) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!allowed.has(key) || !keyOk(ws, key)) {
      failed.push({ key, error: tr(t, "不在可清理范围内：已跳过") });
      continue;
    }
    const abs = toAbs(ws, key);
    try {
      await shell.trashItem(abs);
      const bytes = allowed.get(key) || 0;
      freedBytes += bytes;
      removed.push({ key, bytes });
    } catch (e) {
      failed.push({ key, error: String((e && e.message) || e) });
    }
  }
  return { ok: true, removed, failed, freedBytes };
}

function registerWorkspaceTempIpc(o) {
  const opts = o || {};
  const getDataDir = typeof opts.getDataDir === "function" ? opts.getDataDir : () => "";
  const t = typeof opts.t === "function" ? opts.t : (s) => s;
  ipcMain.handle("wsTemp:scan", async (e, arg) => {
    try {
      const a = arg || {};
      return await scanWorkspace({
        workspace: a.workspace,
        currentWfId: String(a.wfId || ""),
        getDataDir,
        t,
      });
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("wsTemp:clean", async (e, arg) => {
    try {
      const a = arg || {};
      return await cleanWorkspace({
        workspace: a.workspace,
        keys: a.keys,
        currentWfId: String(a.wfId || ""),
        getDataDir,
        t,
      });
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = {
  registerWorkspaceTempIpc,
  /* 纯逻辑出口：供冒烟测试直接驱动同一份实现 */
  scanWorkspace,
  cleanWorkspace,
  collectAllowedKeys,
  keyOk,
  EXCLUDE_NAMES,
};

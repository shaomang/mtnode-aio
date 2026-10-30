"use strict";
/**
 * 项目 manifest · 资产登记 / asset_id 版本 / 依赖图 / 增量重建（数据层，只碰磁盘）
 *
 * 与 docs/text-to-video-pipeline-gap.md 的 P0-2（G2 + G3）对应。这里**只**负责一份
 * `<工程根>/manifest.json` 的读写与推导，不认识画布、不弹窗、不跑节点：
 *   · 资产：`assets[id] = { kind, rev, files, fileHash, anchor, deps }`
 *   · 镜头：`shots[id] = { rev, assets:["id@rev"], deps:[], candidates, final, qa, gen, stale }`
 *   · 依赖图：`edges = [[from,to], ...]`（由镜头引用自动推导 + 手工边）
 *   · 增量：资产 rev 变了 → 只把**直接下游**镜头标 `stale`（不跨镜头传递），
 *     再由 stale_plan 给出「受影响镜头 + 原因」的重建计划，由 Agent / 人执行。
 *
 * 硬口径（与用户共识一致，改之前先读这一段）：
 *   1. 落点 `<工程根>/manifest.json`。**与交付清单区分**：交付清单是
 *      `<画布工作目录>/mtnode-deliverables/<uid>/manifest.json`（保持原名，代码与文档
 *      里统一叫「交付清单」）；本文所有「manifest」都指项目 manifest。
 *   2. 没 init 过就报错并提示先 init —— 不静默建空档（路径打错时不会悄悄生成一份空表）。
 *   3. rev 口径：写入即自动 `rev+1`；**内容哈希没变则不升**（重复登记同一份文件不会把
 *      下游白标脏）。内容 = 归一化后的资产/镜头字段（不含 rev / stale / 时间戳）。
 *   4. 并发：整份原子替换（临时文件 + rename），写操作可带 `expectRev` 做乐观锁；
 *      对不上就拒写并把当前 rev 回给调用方。
 *   5. 越权写：`stage` 不是 `"art"`（含缺省）的资产写入照旧落盘，但记 `needsReview`
 *      并在回执里写明「需人工确认」；镜头写入不设阶段门（镜头本来就在阶段 4+ 产生）。
 *   6. 资产文件只接受**工程内相对路径**（绝对路径 / `..` / 盘符一律拒），登记时校验存在。
 *   7. 所有入口都是同步函数：主进程同一个事件循环里不会出现两笔写交错，天然串行。
 *
 * 单独成文件（而不写在 main.js）的理由：这套「哈希 → rev → 依赖图 → stale」的行为
 * 必须能在 test/smoke-manifest.js 里真跑，不必起 Electron。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MANIFEST_FILE = "manifest.json";
const SCHEMA_VER = 1;
/** 资产阶段门：只有这个阶段的写入不需要人工确认（G3 规则 3） */
const ART_STAGE = "art";
/** 单次写入护栏（manifest 是索引不是仓库，超了说明用法错了） */
const MAX_ASSETS = 500;
const MAX_SHOTS = 5000;
const MAX_EDGES = 20000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([1-9][0-9]{0,8})$/;
const ASSET_KINDS = new Set([
  "character",
  "scene",
  "prop",
  "style",
  "voice",
  "audio",
  "lut",
  "other",
]);

function s(v) {
  return v == null ? "" : String(v);
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function nowIso() {
  return new Date().toISOString();
}
function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** 稳定序列化（键排序）—— 哈希只认它，避免键顺序不同被当成内容变更 */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return (
    "{" +
    keys
      .filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
      .join(",") +
    "}"
  );
}
function sha256Text(t) {
  return crypto.createHash("sha256").update(String(t), "utf8").digest("hex");
}
function sha256File(abs) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch (_) {
    return "";
  }
}

/* ── 路径 ─────────────────────────────────────────────────────────────── */

function absRoot(root) {
  const r = s(root).trim();
  if (!r) {
    const e = new Error(
      "缺少工程根目录：请显式传 root，或给这张画布设置「画布工作目录」（manifest.json 就落在那里）",
    );
    e.code = "no_root";
    throw e;
  }
  const abs = path.resolve(r);
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    st = null;
  }
  if (!st || !st.isDirectory()) {
    const e = new Error("工程根目录不存在：" + abs);
    e.code = "bad_root";
    throw e;
  }
  return abs;
}

/**
 * 工程内相对路径归一：拒绝绝对路径 / 盘符 / `..`。
 * @returns {string} 归一后的正斜杠相对路径（"" = 非法）
 */
function safeRel(p) {
  const raw = s(p).trim();
  if (!raw) return "";
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return "";
  const segs = raw.split(/[\\/]+/);
  const out = [];
  for (const seg of segs) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return "";
    out.push(seg);
  }
  if (!out.length) return "";
  return out.join("/");
}

function manifestPathOf(root) {
  return path.join(absRoot(root), MANIFEST_FILE);
}

/* ── 数据结构 ─────────────────────────────────────────────────────────── */

function emptyManifest(project) {
  return {
    ver: SCHEMA_VER,
    project: s(project).trim() || "project",
    rev: 0,
    updatedAt: nowIso(),
    assets: {},
    shots: {},
    edges: [],
    manualEdges: [],
    needsReview: [],
  };
}

/**
 * 归一化一条资产（保留合法已知字段，丢弃未知键；files / deps 归一成字符串表）。
 * @returns {{asset:object}|{error:string}}
 */
function normalizeAsset(raw) {
  const a = raw && typeof raw === "object" ? raw : null;
  if (!a) return { error: "asset 必须是对象" };
  const id = s(a.id).trim();
  if (!ID_RE.test(id)) return { error: "资产 id 非法（只允许字母数字 . _ -，≤64）：" + (id || "(空)") };
  const kind = s(a.kind).trim() || "other";
  if (!ASSET_KINDS.has(kind)) {
    return {
      error: "资产 kind 非法：" + kind + "（可用：" + Array.from(ASSET_KINDS).join(" / ") + "）",
    };
  }
  const files = {};
  const src = a.files && typeof a.files === "object" ? a.files : {};
  for (const [k, v] of Object.entries(src)) {
    const slot = s(k).trim();
    if (!slot) continue;
    const rel = safeRel(v);
    if (!rel) return { error: "资产 " + id + " 的 files." + slot + " 必须是工程内相对路径" };
    files[slot] = rel;
  }
  if (!Object.keys(files).length) return { error: "资产 " + id + " 至少要有一个 files 条目" };
  const anchor = a.anchor && typeof a.anchor === "object" ? clone(a.anchor) : {};
  const deps = arr(a.deps)
    .map((d) => s(d).trim())
    .filter(Boolean);
  const out = {
    id,
    kind,
    label: s(a.label).trim() || id,
    files,
    anchor,
    deps,
    needsReview: false,
    updatedAt: nowIso(),
  };
  /* 内容指纹：文件内容哈希 + anchor + kind —— rev 只跟它走（mtime 不算内容） */
  const fileHash = {};
  for (const [slot, rel] of Object.entries(files)) fileHash[slot] = rel;
  out.fileHash = fileHash;
  out.contentHash = sha256Text(stableStringify({ kind, files, anchor, deps }));
  return { asset: out };
}

function normalizeShot(raw) {
  const x = raw && typeof raw === "object" ? raw : null;
  if (!x) return { error: "shot 必须是对象" };
  const id = s(x.id || x.shot_id).trim();
  if (!ID_RE.test(id)) return { error: "镜头 id 非法：" + (id || "(空)") };
  const assets = arr(x.assets)
    .map((v) => s(v).trim())
    .filter(Boolean);
  for (const ref of assets) {
    if (!REF_RE.test(ref)) return { error: "镜头 " + id + " 的 assets 项必须是 id@rev：" + ref };
  }
  const deps = arr(x.deps)
    .map((d) => s(d).trim())
    .filter(Boolean)
    .map((d) => {
      if (d.startsWith("file:")) {
        const rel = safeRel(d.slice(5));
        return rel ? "file:" + rel : "";
      }
      if (d.startsWith("asset:")) return d;
      return d;
    })
    .filter(Boolean);
  const out = {
    id,
    rev: 0,
    specRef: s(x.specRef).trim(),
    spec: x.spec && typeof x.spec === "object" ? clone(x.spec) : undefined,
    assets,
    deps,
    candidates: arr(x.candidates)
      .map((v) => s(v).trim())
      .filter(Boolean),
    final: s(x.final).trim(),
    qa: s(x.qa).trim(),
    gen: x.gen && typeof x.gen === "object" ? clone(x.gen) : {},
    stale: false,
    staleReasons: [],
    needsReview: false,
    updatedAt: nowIso(),
  };
  out.contentHash = sha256Text(
    stableStringify({
      specRef: out.specRef,
      spec: out.spec,
      assets: out.assets,
      deps: out.deps,
      candidates: out.candidates,
      final: out.final,
      qa: out.qa,
      gen: out.gen,
    }),
  );
  return { shot: out };
}

/** 依赖图：镜头引用推导出的边 + 手工边（去重、稳定排序） */
function recomputeEdges(m) {
  const set = new Map();
  const add = (from, to) => {
    const f = s(from).trim();
    const t = s(to).trim();
    if (!f || !t) return;
    set.set(f + " -> " + t, [f, t]);
  };
  for (const shot of Object.values(m.shots || {})) {
    const to = "shot:" + shot.id + "@" + shot.rev;
    for (const ref of arr(shot.assets)) add("asset:" + ref, to);
    for (const dep of arr(shot.deps)) add(dep, to);
  }
  for (const e of arr(m.manualEdges)) {
    if (Array.isArray(e) && e.length >= 2) add(e[0], e[1]);
  }
  m.edges = Array.from(set.values()).sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  while (m.edges.length > MAX_EDGES) m.edges.shift();
  return m.edges;
}

/* ── 读写 ─────────────────────────────────────────────────────────────── */

function normalizeManifest(raw) {
  const m = emptyManifest(raw && raw.project);
  if (!raw || typeof raw !== "object") return m;
  m.ver = SCHEMA_VER;
  m.project = s(raw.project).trim() || m.project;
  m.rev = Math.max(0, Math.floor(Number(raw.rev) || 0));
  m.updatedAt = s(raw.updatedAt) || nowIso();
  for (const [id, a] of Object.entries(raw.assets && typeof raw.assets === "object" ? raw.assets : {})) {
    if (!a || typeof a !== "object") continue;
    const norm = normalizeAsset(Object.assign({ id }, a));
    if (!norm.asset) continue;
    norm.asset.rev = Math.max(1, Math.floor(Number(a.rev) || 1));
    norm.asset.contentHash = s(a.contentHash) || norm.asset.contentHash;
    if (a.fileHash && typeof a.fileHash === "object") norm.asset.fileHash = Object.assign({}, a.fileHash);
    norm.asset.needsReview = !!a.needsReview;
    norm.asset.updatedAt = s(a.updatedAt) || norm.asset.updatedAt;
    m.assets[id] = norm.asset;
  }
  for (const [id, x] of Object.entries(raw.shots && typeof raw.shots === "object" ? raw.shots : {})) {
    if (!x || typeof x !== "object") continue;
    const norm = normalizeShot(Object.assign({ id }, x));
    if (!norm.shot) continue;
    norm.shot.rev = Math.max(1, Math.floor(Number(x.rev) || 1));
    norm.shot.stale = !!x.stale;
    norm.shot.staleReasons = arr(x.staleReasons).filter(Boolean);
    norm.shot.needsReview = !!x.needsReview;
    norm.shot.contentHash = s(x.contentHash) || norm.shot.contentHash;
    m.shots[id] = norm.shot;
  }
  m.manualEdges = arr(raw.manualEdges)
    .filter((e) => Array.isArray(e) && e.length >= 2)
    .map((e) => [s(e[0]).trim(), s(e[1]).trim()]);
  m.needsReview = arr(raw.needsReview).filter((x) => x && typeof x === "object");
  recomputeEdges(m);
  return m;
}

/**
 * 读工程 manifest。没 init 过 → 明确报错并提示先 init（共识：不静默建空档）。
 * @returns {{ok:true, root:string, manifest:object}|{ok:false, error:string, code?:string}}
 */
function readManifest(root) {
  let abs;
  try {
    abs = absRoot(root);
  } catch (e) {
    return { ok: false, error: s(e && e.message), code: s(e && e.code) };
  }
  const fp = path.join(abs, MANIFEST_FILE);
  let text = "";
  try {
    text = fs.readFileSync(fp, "utf8");
  } catch (_) {
    return {
      ok: false,
      code: "not_initialized",
      error:
        "工程里还没有 manifest.json（" +
        fp +
        "）：先调用 action:\"init\" 建一份资产登记表，再登记资产 / 镜头",
    };
  }
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      code: "bad_json",
      error: "manifest.json 不是合法 JSON（" + fp + "）：" + s(e && e.message),
    };
  }
  return { ok: true, root: abs, manifest: normalizeManifest(raw) };
}

/** 原子写：同目录临时文件 + rename（半截文件绝不可能被读到） */
function writeManifest(root, m) {
  const abs = absRoot(root);
  const fp = path.join(abs, MANIFEST_FILE);
  const tmp = fp + "." + process.pid + "." + Date.now() + ".tmp";
  m.ver = SCHEMA_VER;
  m.updatedAt = nowIso();
  const text = JSON.stringify(m, null, 2) + "\n";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, fp);
  return { path: fp, bytes: Buffer.byteLength(text) };
}

/* ── 业务动作 ─────────────────────────────────────────────────────────── */

function stageNeedsReview(stage) {
  return s(stage).trim().toLowerCase() !== ART_STAGE;
}

function conflict(m, expectRev) {
  const want = Number(expectRev);
  if (!Number.isFinite(want) || want < 0) return null;
  if (Math.floor(want) !== m.rev) {
    return {
      ok: false,
      code: "rev_conflict",
      error:
        "manifest 已被改动（当前 rev=" + m.rev + "，你带的 expectRev=" + Math.floor(want) +
        "）：请重新 get 一遍再写",
      rev: m.rev,
    };
  }
  return null;
}

/** 资产 rev 变更 → 只标**直接下游**镜头 stale（不跨镜头传递） */
function markStaleForAsset(m, assetId, fromRev, toRev) {
  const hit = [];
  for (const shot of Object.values(m.shots)) {
    const refs = arr(shot.assets).concat(arr(shot.deps).filter((d) => d.startsWith("asset:")));
    let uses = false;
    for (const ref of refs) {
      const raw = ref.startsWith("asset:") ? ref.slice(6) : ref;
      const mm = REF_RE.exec(raw);
      if (mm && mm[1] === assetId) uses = true;
      else if (!mm && raw === assetId) uses = true;
    }
    if (!uses) continue;
    shot.stale = true;
    shot.staleReasons = arr(shot.staleReasons).filter(Boolean);
    if (!shot.staleReasons.some((r) => r && r.code === "asset_changed" && r.id === assetId && r.toRev === toRev)) {
      shot.staleReasons.push({ code: "asset_changed", id: assetId, fromRev, toRev, at: nowIso() });
    }
    hit.push(shot.id);
  }
  /* 镜头被标脏 → 依赖它的手工边（显式连续性）不在本轮传递（共识：只直接下游） */
  return hit.sort();
}

function assetRefsOf(shot) {
  const set = new Set();
  for (const ref of arr(shot && shot.assets)) set.add(ref);
  for (const dep of arr(shot && shot.deps)) {
    if (dep.startsWith("asset:")) set.add(dep.slice(6));
  }
  return Array.from(set);
}

function resolveRef(m, ref) {
  const mm = REF_RE.exec(s(ref).trim());
  if (!mm) return { ok: false, reason: "不是 id@rev 形式：" + ref };
  const id = mm[1];
  const rev = Number(mm[2]);
  const a = m.assets[id];
  if (!a) return { ok: false, id, rev, reason: "manifest 里没有资产 " + id };
  if (Number(a.rev) !== rev) {
    return {
      ok: false,
      id,
      rev,
      actualRev: a.rev,
      reason: "资产 " + id + " 当前 rev=" + a.rev + "，引用的是 @" + rev + "（陈旧引用）",
    };
  }
  return { ok: true, id, rev };
}

function validateRefs(m, refs) {
  const errors = [];
  const list = arr(refs).map((r) => s(r).trim()).filter(Boolean);
  if (!list.length) errors.push({ path: "assetRefs", msg: "assetRefs 为空：已开 requireAsset 的节点必须声明至少一个 id@rev" });
  for (const ref of list) {
    const r = resolveRef(m, ref);
    if (!r.ok) errors.push({ path: "assetRefs", ref, msg: r.reason });
  }
  return { ok: errors.length === 0, errors, refs: list };
}

function validateAll(m, root) {
  const errors = [];
  for (const a of Object.values(m.assets)) {
    for (const [slot, rel] of Object.entries(a.files || {})) {
      const abs = path.join(root, rel);
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch (_) {
        st = null;
      }
      if (!st || !st.isFile()) {
        errors.push({ path: "assets." + a.id + ".files." + slot, msg: "文件不存在：" + rel });
      }
    }
  }
  for (const shot of Object.values(m.shots)) {
    if (!arr(shot.assets).length) {
      errors.push({ path: "shots." + shot.id + ".assets", msg: "镜头没有登记任何资产引用（assets 为空）" });
    }
    for (const ref of assetRefsOf(shot)) {
      const r = resolveRef(m, ref);
      if (!r.ok) errors.push({ path: "shots." + shot.id + ".assets", ref, msg: r.reason });
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    checked: { assets: Object.keys(m.assets).length, shots: Object.keys(m.shots).length },
  };
}

/**
 * 执行一个 manifest 动作（IPC / Agent 工具 / 测试共用的唯一入口）。
 * @param {string} root 工程根（manifest.json 所在目录）
 * @param {string} action
 * @param {object} [params]
 */
function applyOp(root, action, params) {
  const p = params && typeof params === "object" ? params : {};
  const act = s(action).trim() || "get";
  if (act === "init") {
    let abs;
    try {
      abs = absRoot(root);
    } catch (e) {
      return { ok: false, code: s(e && e.code), error: s(e && e.message) };
    }
    const fp = path.join(abs, MANIFEST_FILE);
    if (fs.existsSync(fp)) {
      const cur = readManifest(abs);
      if (!cur.ok) return cur;
      return {
        ok: true,
        created: false,
        root: abs,
        path: fp,
        project: cur.manifest.project,
        rev: cur.manifest.rev,
        note: "manifest.json 已存在，未覆盖",
      };
    }
    const m = emptyManifest(p.project || path.basename(abs));
    const w = writeManifest(abs, m);
    return {
      ok: true,
      created: true,
      root: abs,
      path: w.path,
      bytes: w.bytes,
      project: m.project,
      rev: m.rev,
    };
  }

  const rd = readManifest(root);
  if (!rd.ok) return rd;
  const abs = rd.root;
  const m = rd.manifest;

  if (act === "get") {
    const ids = arr(p.ids).map((x) => s(x).trim()).filter(Boolean);
    let assets = m.assets;
    let shots = m.shots;
    if (ids.length) {
      assets = {};
      shots = {};
      for (const id of ids) {
        if (m.assets[id]) assets[id] = m.assets[id];
        if (m.shots[id]) shots[id] = m.shots[id];
      }
    }
    return {
      ok: true,
      root: abs,
      path: path.join(abs, MANIFEST_FILE),
      ver: m.ver,
      project: m.project,
      rev: m.rev,
      updatedAt: m.updatedAt,
      assets,
      shots,
      edges: m.edges,
      needsReview: m.needsReview,
      counts: { assets: Object.keys(m.assets).length, shots: Object.keys(m.shots).length },
    };
  }

  if (act === "stale_plan") {
    const stale = [];
    for (const shot of Object.values(m.shots)) {
      if (!shot.stale) continue;
      stale.push({
        shot: shot.id,
        rev: shot.rev,
        reasons: shot.staleReasons,
        assets: shot.assets,
        final: shot.final,
        qa: shot.qa,
      });
    }
    stale.sort((a, b) => (a.shot < b.shot ? -1 : a.shot > b.shot ? 1 : 0));
    return {
      ok: true,
      rev: m.rev,
      count: stale.length,
      stale,
      plan: stale.map((x) => ({ shot: x.shot, rev: x.rev, why: x.reasons })),
      note: stale.length
        ? "以下镜头需要重建（只标直接下游）：按 plan 重跑对应生成环节，完成后用 rebuild_done 清脏"
        : "没有 stale 镜头：依赖图上的所有镜头都与当前资产版本一致",
    };
  }

  if (act === "validate") {
    return Object.assign({ ok: true, rev: m.rev }, validateAll(m, abs));
  }

  if (act === "validate_refs") {
    const r = validateRefs(m, p.refs);
    return Object.assign({ ok: r.ok, rev: m.rev, refs: r.refs, errors: r.errors }, {});
  }

  const cf = conflict(m, p.expectRev);
  if (cf) return cf;

  if (act === "asset_set") {
    const norm = normalizeAsset(p.asset);
    if (norm.error) return { ok: false, code: "bad_asset", error: norm.error };
    const next = norm.asset;
    const prev = m.assets[next.id] || null;
    const nr = stageNeedsReview(p.stage);
    if (!prev && Object.keys(m.assets).length >= MAX_ASSETS) {
      return { ok: false, code: "too_many_assets", error: "资产数超过上限 " + MAX_ASSETS };
    }
    /* 文件必须已经在工程里（共识：只记工程内相对路径，登记时校验存在） */
    const missing = [];
    for (const [slot, rel] of Object.entries(next.files)) {
      const fabs = path.join(abs, rel);
      let st = null;
      try {
        st = fs.statSync(fabs);
      } catch (_) {
        st = null;
      }
      if (!st || !st.isFile()) missing.push(slot + " → " + rel);
    }
    if (missing.length) {
      return {
        ok: false,
        code: "missing_files",
        error: "资产 " + next.id + " 的文件不存在（工程内相对路径，按 " + abs + " 解析）：" + missing.join("；"),
      };
    }
    /* 内容指纹 = 字段指纹 + **文件内容哈希**：同一路径换了字节也要升 rev，
       同一份文件重复登记则不动（否则下游会被白标脏） */
    const fileHash = {};
    for (const [slot, rel] of Object.entries(next.files)) fileHash[slot] = sha256File(path.join(abs, rel));
    next.fileHash = fileHash;
    next.contentHash = sha256Text(stableStringify({ fields: next.contentHash, fileHash }));
    const changed = !prev || prev.contentHash !== next.contentHash;
    next.rev = prev ? (changed ? prev.rev + 1 : prev.rev) : 1;
    next.needsReview = nr;
    m.assets[next.id] = next;
    let staleShots = [];
    if (prev && changed) staleShots = markStaleForAsset(m, next.id, prev.rev, next.rev);
    if (nr) {
      m.needsReview = arr(m.needsReview).filter((x) => !(x.kind === "asset" && x.id === next.id));
      m.needsReview.push({ kind: "asset", id: next.id, stage: s(p.stage) || "(未填)", at: nowIso() });
    } else {
      m.needsReview = arr(m.needsReview).filter((x) => !(x.kind === "asset" && x.id === next.id));
    }
    recomputeEdges(m);
    m.rev += 1;
    const w = writeManifest(abs, m);
    return {
      ok: true,
      path: w.path,
      root: abs,
      rev: m.rev,
      asset: { id: next.id, kind: next.kind, rev: next.rev, changed },
      staleShots,
      needsReview: nr,
      note: nr
        ? "已落盘，但写入阶段不是 \"art\"：该资产标记为 needsReview，需要人工确认（请向用户请示）"
        : "",
    };
  }

  if (act === "asset_del") {
    const id = s(p.id).trim();
    if (!m.assets[id]) return { ok: false, code: "not_found", error: "manifest 里没有资产 " + id };
    const users = Object.values(m.shots)
      .filter((shot) => assetRefsOf(shot).some((ref) => (REF_RE.exec(ref) || [])[1] === id))
      .map((shot) => shot.id)
      .sort();
    delete m.assets[id];
    m.needsReview = arr(m.needsReview).filter((x) => !(x.kind === "asset" && x.id === id));
    recomputeEdges(m);
    m.rev += 1;
    const w = writeManifest(abs, m);
    return {
      ok: true,
      path: w.path,
      rev: m.rev,
      removed: id,
      usedBy: users,
      note: users.length ? "这些镜头仍引用已删除的资产，validate 会报缺失" : "",
    };
  }

  if (act === "shot_set") {
    const norm = normalizeShot(p.shot);
    if (norm.error) return { ok: false, code: "bad_shot", error: norm.error };
    const next = norm.shot;
    const prev = m.shots[next.id] || null;
    if (!prev && Object.keys(m.shots).length >= MAX_SHOTS) {
      return { ok: false, code: "too_many_shots", error: "镜头数超过上限 " + MAX_SHOTS };
    }
    /* 引用先校验：镜头登记时把不存在的 id@rev 直接挡下来（G3 规则 1） */
    const bad = [];
    for (const ref of assetRefsOf(next)) {
      const r = resolveRef(m, ref);
      if (!r.ok) bad.push(r.reason);
    }
    if (bad.length) {
      return {
        ok: false,
        code: "bad_asset_ref",
        error: "镜头 " + next.id + " 的资产引用无效：" + bad.join("；") + "（先登记资产，或把 @rev 改成当前版本）",
      };
    }
    const changed = !prev || prev.contentHash !== next.contentHash;
    next.rev = prev ? (changed ? prev.rev + 1 : prev.rev) : 1;
    /* 重建过的镜头：新内容写进来即视为已重建，清掉 stale */
    if (changed || !prev) {
      next.stale = false;
      next.staleReasons = [];
    } else if (prev) {
      next.stale = prev.stale;
      next.staleReasons = prev.staleReasons;
    }
    m.shots[next.id] = next;
    recomputeEdges(m);
    m.rev += 1;
    const w = writeManifest(abs, m);
    return {
      ok: true,
      path: w.path,
      root: abs,
      rev: m.rev,
      shot: { id: next.id, rev: next.rev, changed, stale: next.stale },
    };
  }

  if (act === "shot_del") {
    const id = s(p.id).trim();
    if (!m.shots[id]) return { ok: false, code: "not_found", error: "manifest 里没有镜头 " + id };
    delete m.shots[id];
    m.needsReview = arr(m.needsReview).filter((x) => !(x.kind === "shot" && x.id === id));
    recomputeEdges(m);
    m.rev += 1;
    const w = writeManifest(abs, m);
    return { ok: true, path: w.path, rev: m.rev, removed: id };
  }

  if (act === "edge_add" || act === "edge_del") {
    const from = s(p.from).trim();
    const to = s(p.to).trim();
    if (!from || !to) return { ok: false, code: "bad_edge", error: "边需要 from 与 to（形如 asset:char_lin@3 / shot:S03_005@2）" };
    const key = from + " -> " + to;
    const has = arr(m.manualEdges).some((e) => Array.isArray(e) && e[0] + " -> " + e[1] === key);
    if (act === "edge_add") {
      if (!has) m.manualEdges.push([from, to]);
    } else if (has) {
      m.manualEdges = m.manualEdges.filter((e) => !(Array.isArray(e) && e[0] + " -> " + e[1] === key));
    }
    recomputeEdges(m);
    m.rev += 1;
    const w = writeManifest(abs, m);
    return {
      ok: true,
      path: w.path,
      rev: m.rev,
      changed: act === "edge_add" ? !has : has,
      note: "手工边只进依赖图，不参与 stale 传播（共识：只标直接下游）",
    };
  }

  if (act === "qa_set") {
    /* 自动质检（proc_qa）回写：镜头带报告路径 + 未过即标脏。
       判据与 stale 语义沿用资产变更那一套（staleReasons 里一条结构化原因，不覆盖别的原因）。 */
    const id = s(p.id || p.shot_id).trim();
    const shot = m.shots[id];
    if (!shot) return { ok: false, code: "not_found", error: "manifest 里没有镜头 " + id };
    const rawVerdict = s(p.verdict).trim().toLowerCase();
    if (rawVerdict !== "pass" && rawVerdict !== "fail") {
      return {
        ok: false,
        code: "bad_verdict",
        error: "verdict 只能是 pass / fail（收到「" + s(p.verdict) + "」）；blocked 不写 manifest",
      };
    }
    const verdict = rawVerdict;
    const round = Math.max(0, Math.floor(Number(p.round) || 0));
    const rel = p.report ? safeRel(p.report) : shot.qa ? shot.qa : "";
    shot.qa = rel || shot.qa || "";
    shot.staleReasons = arr(shot.staleReasons).filter(
      (r) => !(r && typeof r === "object" && r.code === "qa_failed") && r !== "qa_failed",
    );
    if (verdict !== "pass") {
      shot.stale = true;
      shot.staleReasons.push({
        code: "qa_failed",
        verdict,
        round,
        report: shot.qa,
        at: nowIso(),
      });
    } else if (!shot.staleReasons.length) {
      shot.stale = false;
    }
    m.rev += 1;
    const w = writeManifest(abs, m);
    return {
      ok: true,
      path: w.path,
      root: abs,
      rev: m.rev,
      shot: { id, qa: shot.qa, verdict, stale: !!shot.stale, staleReasons: shot.staleReasons },
    };
  }

  if (act === "rebuild_done") {
    const ids = arr(p.shots).map((x) => s(x).trim()).filter(Boolean);
    const cleared = [];
    const unknown = [];
    for (const id of ids) {
      const shot = m.shots[id];
      if (!shot) {
        unknown.push(id);
        continue;
      }
      if (shot.stale) {
        shot.stale = false;
        shot.staleReasons = [];
        cleared.push(id);
      }
    }
    m.rev += 1;
    const w = writeManifest(abs, m);
    return { ok: true, path: w.path, rev: m.rev, cleared, unknown };
  }

  return {
    ok: false,
    code: "bad_action",
    error:
      "未知动作 " + act + "（可用：init / get / asset_set / asset_del / shot_set / shot_del / " +
      "qa_set / edge_add / edge_del / stale_plan / validate / validate_refs / rebuild_done）",
  };
}

module.exports = {
  MANIFEST_FILE,
  ART_STAGE,
  ASSET_KINDS,
  applyOp,
  readManifest,
  normalizeAsset,
  normalizeShot,
  safeRel,
  manifestPathOf,
  // 纯函数（测试直接用）
  stableStringify,
  recomputeEdges,
  markStaleForAsset,
  validateRefs,
  validateAll,
};

"use strict";
/* canvas-doc-service —— 主进程侧的画布文档服务（读侧常驻 + 写侧执行，flag = canvases.docService）
 * ============================================================================
 * 一句话：把「Agent 读画布」与「Agent 改画布」这两件活从渲染层搬到主进程 ——
 *   · 读：文档（save/<id>.json）在主进程惰性装载并常驻，快照由共享内核
 *     canvas-doc/canvas-doc-core.js 算；
 *   · 写（flag = write）：文档也在主进程，编辑由共享引擎 canvas-doc/canvas-doc-edit.js 执行、
 *     由本服务落盘，渲染层只拿「回执 + 差量」，把它合进 S.wf 并重绘一次。
 * 宿主（节点原语）由 canvas-doc/canvas-doc-host.js 整份装载的渲染层提供。
 * 渲染层那条老路整体保留：开关 off（缺省）时一行都不走这里，行为与今天完全一致；
 * write 档随时可以退回 read / off。
 *
 * 入口（全在主进程）：
 *   const svc = createCanvasDocService({ saveDir, readJson, i18n });
 *   await svc.get(id, opts)      → { ok:true, snapshot } | { ok:false, error }
 *   await svc.edit(id, params, { runKey, snap })
 *                                → { ok:true, receipt, warnings, effects, diff, rev } | { ok:false, error }
 *   svc.putDoc(id, doc)          → 画布落盘后同步（main.js 的 writeWorkflowJson 调它）
 *   svc.markDirty(id, nodeIds)   → 只记脏节点（不发整份文档）
 *   svc.invalidate(id) / forget(id) → 丢掉内存文档（下次 get 重读）
 *   svc.list()                   → 画布列表（**只在真要 workflows 段时才调**）
 *   svc.status()                 → 状态自检（文档数 / rev / 脏集合 / 宿主装层面）
 *
 * 口径（与渲染层 canvasSnapshotFull 逐处对齐，只有文档视角的差）：
 *   · detail / sections / ids / bodies / bodyLimit / scope 全档位透传给内核，一处不拦；
 *   · wfList **惰性**：只有本次请求真要看 workflows 段才扫 save/（渲染层每次都扫）；
 *   · childCount 由内核一次 Map<parentId,count> 预聚合（O(n)，不再逐节点 filter）；
 *   · contentHash 挂在 rev 上：同一版文档只算一次（内核算在真源 wf 上，与档位无关）；
 *   · 脏节点集合：自上次 get 以来变过 / 新增的节点 id，putDoc 时按节点指纹 diff 得出。
 *   · 渲染层独有的现场（选中项 / 助手面板开关 / 素材库条目正文 / 会话锁定文案）不在这里
 *     编造：选中与面板开关由渲染层在回执上补（它才知道 UI 现场），素材正文与会话锁定归
 *     渲染层那条路。下文每个字段的归属都写明了，不靠猜。
 *   · 写侧落盘走 writeWorkflowJson（renderer 那条落盘链的同一个主进程出口）：正本 +
 *     应用目录镜像 + putDoc 同步，一处都不绕。产品里本服务跑在 utilityProcess 中
 *     （canvas-doc/canvas-doc-worker.js），那份 writeDoc 是「跨进程请主进程落盘」的异步
 *     实现，所以 edit() 里对它是 await 的 —— 同一份代码，进程内外都成立。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");

const MTCanvasDoc = require("./canvas-doc-core.js");
const MTCanvasDocDiff = require("./canvas-doc-diff.js");
const { createCanvasDocHost } = require("./canvas-doc-host.js");

/* 落盘兜底（没给 writeDoc 时用，口径与 main.js 的 writeJson 一致：2 空格 + 临时文件 + rename）。
   给了 writeDoc（产品里是 main.js 的 writeWorkflowJson）就走那条 —— 应用画布镜像与 putDoc 都在里面。 */
function atomicWriteJson(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "." + path.basename(p) + "." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return { ok: true, mtime: Date.now() };
}


/* 节点指纹（脏集合 diff 用）：只留 16 进制摘要，不把整份节点再存一遍 */
function fnvHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
function nodeSigsOf(doc) {
  const out = new Map();
  const nodes = (doc && doc.nodes) || [];
  for (const n of nodes) {
    if (!n || !n.id) continue;
    try {
      out.set(String(n.id), fnvHex(JSON.stringify(n)));
    } catch {
      /* 循环引用 / 不可序列化：这一颗永远算「变过」，比漏报安全 */
      out.set(String(n.id), "-");
    }
  }
  return out;
}

function createCanvasDocService(opts) {
  opts = opts || {};
  const saveDir = String(opts.saveDir || "");
  const readJson =
    opts.readJson ||
    ((p, fb) => {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        return fb;
      }
    });
  const I18n = opts.i18n || require("../renderer/i18n.js");
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const writeDoc =
    typeof opts.writeDoc === "function" ? opts.writeDoc : (p, obj) => atomicWriteJson(p, obj);

  const host = opts.host || createCanvasDocHost({ i18n: I18n });
  /** id → { doc, rev, dirty:Set, hash, hashRev, fileSig, sigs, at } */
  const docs = new Map();
  let wfListCache = { byId: new Map(), rows: [] };

  const filePathOf = (id) => path.join(saveDir, String(id) + ".json");
  function fileSigOf(id) {
    try {
      const st = fs.statSync(filePathOf(id));
      return st.mtimeMs + ":" + st.size;
    } catch {
      return "";
    }
  }
  function hostReady() {
    return host.ready();
  }

  /* ── 惰性装载：命中内存就返回；文件 stat 变了（别处存过盘）就重读 ── */
  function entryOf(id) {
    const key = String(id || "");
    if (!key) throw new Error(I18n.t("缺画布 id"));
    const sig = fileSigOf(key);
    let e = docs.get(key);
    /* 文件没了（删掉 / 移走）：内存里那份也作废，下一次读如实回「画布不存在」，
       绝不拿旧文档冒充真源。 */
    if (sig === "") {
      docs.delete(key);
      e = null;
    }
    if (e && e.fileSig === sig) return e;
    const doc = readJson(filePathOf(key), null);
    if (!doc || typeof doc !== "object") throw new Error(I18n.t("画布不存在：") + key);
    if (e) {
      /* 别处改过盘：文档换新版，脏集合按指纹 diff 记一遍（渲染层没走 putDoc 的场合） */
      e.dirty = diffSigs(e.sigs, (e.sigs = nodeSigsOf(doc)));
      e.doc = doc;
      e.rev++;
      e.hashRev = -1;
      e.fileSig = sig;
      e.at = Date.now();
      return e;
    }
    e = {
      doc,
      rev: 1,
      dirty: new Set(),
      hash: "",
      hashRev: -1,
      fileSig: sig,
      sigs: nodeSigsOf(doc),
      at: Date.now(),
    };
    docs.set(key, e);
    return e;
  }
  function diffSigs(prev, next) {
    const dirty = new Set();
    if (!prev) {
      for (const id of next.keys()) dirty.add(id);
      return dirty;
    }
    for (const [id, sig] of next) if (prev.get(id) !== sig) dirty.add(id);
    return dirty;
  }

  /* ── 文档版本（contentHash 挂在 rev 上：同一版只算一次） ── */
  function hashOf(e) {
    if (e.hashRev === e.rev && e.hash) return e.hash;
    e.hash = host.contentHash();
    e.hashRev = e.rev;
    return e.hash;
  }

  /* ── 画布列表（wfList）：只在请求 workflows 段时才取；按 (mtime,size) 免重读 ── */
  function list() {
    const rows = [];
    let names = [];
    try {
      names = fs.readdirSync(saveDir);
    } catch {
      names = [];
    }
    for (const f of names) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      const p = path.join(saveDir, f);
      let st = null;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      const e = docs.get(id);
      const cached = wfListCache.byId && wfListCache.byId.get(id);
      let name = "";
      let nodes = 0;
      if (e && e.fileSig === st.mtimeMs + ":" + st.size) {
        name = String(e.doc.name || "");
        nodes = (e.doc.nodes || []).length;
      } else if (cached && cached.sig === st.mtimeMs + ":" + st.size) {
        name = cached.name;
        nodes = cached.nodes;
      } else {
        const j = readJson(p, null);
        if (!j) continue;
        name = String(j.name || "");
        nodes = (j.nodes || []).length;
      }
      rows.push({ id, name, nodes, at: st.mtimeMs, sig: st.mtimeMs + ":" + st.size });
    }
    rows.sort((a, b) => (b.at || 0) - (a.at || 0));
    wfListCache = {
      byId: new Map(rows.map((r) => [r.id, r])),
      rows: rows.map((r) => ({ id: r.id, name: r.name, nodes: r.nodes, updatedAt: r.at })),
    };
    return wfListCache.rows;
  }

  /* ── 读：canvas_get 全档位 ──
     装配顺序与渲染层 canvasSnapshotFull 一致（workflows → selection → assistOpen →
     minimal 收口 → sections 过滤 → contentHash），只做**文档视角**该有的取舍：
       · selection 恒空（选中是 UI 现场，渲染层会在回执上补）；
       · assistOpen / sidebarOpen 恒 false（同上）；
       · 会话锁定的 scopeNote / 单张 workflows 由渲染层在回执上补（它才知道本轮锁没锁）。 */
  async function get(id, snapshotOpts) {
    const o = MTCanvasDoc.normalizeSnapshotOpts(snapshotOpts || {});
    const want = (k) => MTCanvasDoc.snapshotWantsSection(o, snapshotOpts || {}, k);
    let e = null;
    try {
      e = entryOf(id);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    try {
      await hostReady();
      /* token = 「哪张画的哪一版」：跨画布复用同一个宿主时，rev 会重复（两张画布都有 rev 1），
         所以这里必须带 id，否则第二张画布会读到上一张的现场。 */
      host.load(e.doc, String(id) + "@" + e.rev);
      host.canonicalize();
      const snap = host.snapshot(snapshotOpts || {});
      if (want("workflows")) {
        const rows = list();
        snap.workflows = rows.map((w) => ({
          id: w.id,
          name: w.name,
          nodes: w.nodes,
          active: w.id === String(id),
        }));
      } else {
        delete snap.workflows;
      }
      if (want("selection")) snap.selection = [];
      else delete snap.selection;
      if (o.detail !== "minimal") {
        snap.assistOpen = false;
        snap.sidebarOpen = false;
      }
      if (o.detail === "minimal" && !want("workflows")) delete snap.workflows;
      MTCanvasDoc.applySnapshotSectionFilter(snap, (snapshotOpts || {}).sections);
      /* 哈希必须在快照之后算，且按 rev 记住：内核的标签归一化（normalizeNodeTags）会把
         `tags: []` 写进真源节点，第一次读之后文档就与落盘那份不同了。渲染层那条路也是
         「渲染完再算」，这里跟上同一个顺序，同一版文档两路才给同一个 contentHash；
         又因为结果挂在 rev 上，同一版只算一次，之后读到的哈希不会随渲染顺序漂。 */
      snap.contentHash = hashOf(e);
      /* 脏集合语义：自上次读以来变过的节点；读完即清（下次读到的就是这一版） */
      e.dirty.clear();
      return { ok: true, snapshot: snap, rev: e.rev };
    } catch (err) {
      const msg = String((err && err.message) || err);
      log("[canvas-doc] get 失败：" + msg);
      return { ok: false, error: msg };
    }
  }

  /* ── 写：一次编辑（flag = write） ──
     顺序 = 「装载文档 → 在真源上跑编辑本体 → 算差量 → 落盘 → 更新内存版本」。
     渲染层拿到的是 { receipt, diff }：回执与搬家前逐字段一致（快照由渲染层补，它才知道
     选中项与面板现场），差量由 MTCanvasDocDiff 算、渲染层用它就地合进 S.wf。
     失败一律折成 { ok:false, error }：错误文案就是引擎抛的那一句，渲染层原样抛给调用方
     （与本地路径同一句），绝不吞成半份结果。 */
  async function edit(id, params, opts) {
    const o = opts || {};
    const key = String(id || "");
    let e = null;
    try {
      e = entryOf(key);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    const before = e.doc;
    const revBefore = e.rev;
    try {
      await hostReady();
      /* token = 「哪张画的哪一版」：rev 在每次落盘后 +1，所以这里每次都把落盘那份克隆进
         vm 再改 —— 服务侧这份（e.doc）与 vm 里那份永不共享对象，中途抛错也污染不到真源。 */
      host.load(before, key + "@" + revBefore);
      const out = await host.editDoc(params || {}, { runKey: o.runKey, snap: o.snap });
      const nextDoc = out.doc;
      const diff = MTCanvasDocDiff.diffDocs(before, nextDoc);
      const noChange =
        !!(out.effects && out.effects.noChange) || MTCanvasDocDiff.diffIsEmpty(diff);
      if (!noChange) {
        /* 落盘：产品里是 main.js 的 writeWorkflowJson（正本 + 应用目录镜像 + putDoc 同步）。
           必须 await —— 服务跑在 utilityProcess 里时这一次调用是**跨进程**的：主进程用它那条
           异步串行队列写完才回 ack，不 await 就会在字节还没落地时就去 stat 文件、把这一版
           的 fileSig 记成上一版的（任务 7/8）。同步实现（脚本 / 自检）await 一个非 Promise
           值，行为一字不变。 */
        await writeDoc(filePathOf(key), nextDoc);
        /* writeDoc 通常经 putDoc 已经把 e 换成刚写的那份（rev+1）；调用方没接 putDoc 时
           （脚本 / 自检）在这里补一次 —— 两种情形收敛到同一个状态。 */
        if (e.doc !== nextDoc || e.rev === revBefore) {
          e.dirty = diffSigs(e.sigs, (e.sigs = nodeSigsOf(nextDoc)));
          e.doc = nextDoc;
          e.rev = revBefore + 1;
          e.hashRev = -1;
          e.fileSig = fileSigOf(key);
          e.at = Date.now();
          wfListCache = { byId: new Map(), rows: [] };
        }
      }
      return {
        ok: true,
        receipt: out.receipt,
        warnings: out.warnings,
        effects: out.effects,
        diff,
        rev: e.rev,
        changed: !noChange,
      };
    } catch (err) {
      const msg = String((err && err.message) || err);
      log("[canvas-doc] edit 失败：" + msg);
      return { ok: false, error: msg };
    }
  }

  return {
    get,
    edit,
    list,
    /** 画布落盘后同步（main.js 的 writeWorkflowJson 里调）：内存文档换成刚写的那一份 */
    putDoc(id, doc) {
      const key = String(id || "");
      if (!key || !doc || typeof doc !== "object") return false;
      const e = docs.get(key);
      if (!e) return false; /* 没被读过就不常驻：惰性装载的口径不破 */
      e.dirty = diffSigs(e.sigs, (e.sigs = nodeSigsOf(doc)));
      e.doc = doc;
      e.rev++;
      e.hashRev = -1;
      e.fileSig = fileSigOf(key);
      e.at = Date.now();
      wfListCache = { byId: new Map(), rows: [] };
      return true;
    },
    /** 只记脏节点（有粒度的调用方用；文档本身没换，不动 rev 与哈希） */
    markDirty(id, nodeIds) {
      const e = docs.get(String(id || ""));
      if (!e) return false;
      for (const n of nodeIds || []) if (n) e.dirty.add(String(n));
      return true;
    },
    invalidate(id) {
      return docs.delete(String(id || ""));
    },
    forget(id) {
      return docs.delete(String(id || ""));
    },
    status() {
      const rows = [];
      for (const [id, e] of docs) {
        rows.push({
          id,
          rev: e.rev,
          nodes: (e.doc.nodes || []).length,
          dirty: e.dirty.size,
          hash: e.hashRev === e.rev ? e.hash : "",
          fileSig: e.fileSig,
        });
      }
      return { ok: true, saveDir, docs: rows, host: host.describe ? host.describe() : { ok: true } };
    },
  };
}

module.exports = { createCanvasDocService };

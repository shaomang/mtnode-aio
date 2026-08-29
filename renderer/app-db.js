"use strict";
/* ============ 数据库超级节点（事实收纳 → 编译副本 → 工具查询） ============ */

/* 确定性哈希（FNV-1a 32bit）：文件内容指纹，供索引去重与变更比对 */
function dbHash(s) {
  let h = 0x811c9dc5;
  const str = String(s == null ? "" : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/* 可作文本索引的扩展名（二进制/音视频一律不读） */
const DB_TEXT_EXT = new Set([
  "txt", "md", "markdown", "yaml", "yml", "json", "csv", "tsv", "log",
  "xml", "html", "htm", "css", "js", "ts", "py", "mjs", "cjs", "jsonc",
  "toml", "ini", "sql", "sh", "bat", "ps1",
]);
function dbTextishFile(name) {
  const s = String(name || "");
  const i = s.lastIndexOf(".");
  if (i <= 0 || i === s.length - 1) return false;
  return DB_TEXT_EXT.has(s.slice(i + 1).toLowerCase());
}

/* 收集数据库节点的候选记录（内部信息节点 + 子文件夹文本文件）：
   返回带内容哈希的完整记录数组。编译与「检查更新」共用。 */
async function collectDbRecords(node) {
  const records = [];
  /* 1. 内部信息节点（文本内容 / 目标 / 说明） */
  const kids = superChildrenOf(node.id).filter((c) => !isSuperIoNode(c));
  for (const c of kids) {
    if (c.kind === "input_text") {
      const content = String(
        (c.batch && Array.isArray(c.entries) && c.entries.length
          ? c.entries.map((e) => (e && e.content) || "").join("\n")
          : c.text) || "",
      ).trim();
      if (content) {
        records.push({
          id: "rec_" + c.id,
          source: "node:" + c.id,
          kind: "fact",
          title: c.title || "",
          content,
          file: "",
          size: content.length,
          mtime: 0,
          hash: dbHash(content),
        });
      }
    } else {
      const desc = [c.title, c.goal, c.note, c.prompt]
        .filter((x) => typeof x === "string" && x.trim())
        .join(" ")
        .trim();
      if (desc) {
        records.push({
          id: "rec_" + c.id,
          source: "node:" + c.id,
          kind: "meta",
          title: c.title || "",
          content: desc,
          file: "",
          size: desc.length,
          mtime: 0,
          hash: dbHash(desc),
        });
      }
    }
  }
  /* 2. 子文件夹文本文件 */
  const dir = dbNodeDir(node);
  if (dir) {
    const lr = await window.api.fileListDir(dir).catch(() => null);
    if (lr && lr.ok && Array.isArray(lr.list)) {
      for (const f of lr.list) {
        if (!f || !dbTextishFile(f.name)) continue;
        if (f.size > 512 * 1024) continue;
        const full = window.api.pathJoin(dir, f.rel);
        const rr = await window.api.fileReadText(full).catch(() => null);
        const content = rr && rr.ok && rr.exists ? String(rr.content || "") : "";
        records.push({
          id: "rec_f_" + dbHash(f.rel),
          source: "file:" + f.rel,
          kind: "file",
          title: f.name,
          content,
          file: f.rel,
          size: Number(f.size) || 0,
          mtime: Number(f.mtime) || 0,
          hash: dbHash(content || f.rel),
        });
      }
    }
  }
  /* 3. 去重：同 hash + 同 title 只留一条（信息节点优先于文件） */
  const seen = new Set();
  return records.filter((r) => {
    const k = (r.hash || "") + "|" + (r.title || "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function dbNodeDir(node) {
  const ws = String(S.wf.workspace || "").trim();
  const sf = String(node && node.subFolder || "").trim();
  if (!ws || !sf) return "";
  return window.api.pathJoin(ws, sf);
}
/* 手动编译（唯一入口）：内容哈希增量 diff 由主进程 SQLite 完成；
   节点只保存轻量清单（无全文），大库不膨胀画布档案 */
async function compileDbSuper(node) {
  if (!node || node.kind !== "super" || !node.db) return;
  if (node._dbCompiling) return;
  node._dbCompiling = true;
  renderCanvas();
  try {
    const dir = dbNodeDir(node);
    const records = await collectDbRecords(node);
    if (!dir) {
      toast(
        I18n.t("未设置工作目录或子文件夹：文件记录无法入库（仅内部信息节点可编译）"),
        "warn",
      );
    }
    let changes = { added: 0, updated: 0, removed: 0, total: records.length };
    if (dir) {
      const r = await window.api.dbCompile(dir, records).catch(() => null);
      if (!r || !r.ok) throw new Error((r && r.error) || I18n.t("SQLite 编译失败"));
      changes = r;
    }
    /* 清单（无全文）：供副本展示与「检查更新」比对 */
    node.dbIndex = {
      compiledAt: Date.now(),
      folder: String(node.subFolder || "").trim(),
      count: changes.total,
      added: changes.added,
      updated: changes.updated,
      removed: changes.removed,
      records: records.map((r) => ({
        id: r.id,
        source: r.source,
        kind: r.kind,
        title: r.title,
        file: r.file,
        size: r.size,
        mtime: r.mtime,
        hash: r.hash,
      })),
    };
    /* 生成 / 刷新副本节点（供其他节点连线引用） */
    const existing = (S.wf.nodes || []).find(
      (n) => n.kind === "db_replica" && n.dbNodeId === node.id,
    );
    if (existing) {
      existing.dbName = node.title;
      existing.compiledAt = node.dbIndex.compiledAt;
      existing.count = changes.total;
    } else {
      const rep = makeNode("db_replica", node.x + node.w + 60, node.y);
      rep.dbNodeId = node.id;
      rep.dbName = node.title;
      rep.compiledAt = node.dbIndex.compiledAt;
      rep.count = changes.total;
      rep.parentTaskId = node.parentTaskId || "";
      rep.parentSuperId = "";
      rep.title = uniqueNodeTitle(I18n.t("数据库副本") + " · " + (node.title || ""));
      S.wf.nodes.push(rep);
    }
    pushHistory();
    scheduleSave(true);
    renderCanvas();
    toast(
      I18n.t("增量编译完成：+{a} 新增 · ~{u} 更新 · −{r} 移除 · 共 {t} 条", {
        a: changes.added,
        u: changes.updated,
        r: changes.removed,
        t: changes.total,
      }),
      "ok",
    );
  } catch (e) {
    toast(
      I18n.t("数据库编译失败：") + ((e && e.message) || String(e)),
      "err",
    );
  } finally {
    node._dbCompiling = false;
    renderCanvas();
  }
}
/* 数据库形态：内嵌查询 / 调试控制台（调试工具集） */
function renderDbConsoleBody(node, body) {
  const idx = node.dbIndex;
  const st =
    node._dbConsole ||
    (node._dbConsole = { q: "", results: null, calc: null, dirty: null });
  /* 状态行 */
  const meta = document.createElement("div");
  meta.className = "n-db-console-meta";
  meta.innerHTML =
    "<b>" +
    escapeHtml(node.title || "") +
    "</b> · " +
    (idx
      ? idx.count + I18n.t(" 条") + " · " + fmtTime(idx.compiledAt)
      : I18n.t("未编译")) +
    (idx && (idx.added || idx.updated || idx.removed)
      ? " · " +
        I18n.t("上次增量 +{a}/~{u}/−{r}", {
          a: idx.added,
          u: idx.updated,
          r: idx.removed,
        })
      : "") +
    (idx && idx.folder
      ? ' · <span class="n-db-console-folder">' + escapeHtml(idx.folder) + "</span>"
      : "");
  body.appendChild(meta);
  /* 引用提示：!@ 引用方式 + 只读说明（所有处理节点通用，可经 agent 完全增删改查） */
  const hint = document.createElement("div");
  hint.className = "n-db-console-hint";
  const safeHintTitle = escapeHtml(node.title || "");
  hint.innerHTML =
    "📌 " +
    I18n.t("在任意处理节点的 prompt/task 中写 !@数据库标题 即可引用本数据库（无需连线）。") +
    "<br>" +
    I18n.t(
      "智能 / agent 节点：得到「【数据库：标题】」指针，并可用 mtnode_db 工具对本库完整增删改查——",
    ) +
    I18n.t("查：") + "list / get / query（返回 provenance 溯源 + sql 实际访问语句 + data 结构化数据）；" +
    I18n.t("增 / 改：") + "write（records，缺 id 自动生成）；" +
    I18n.t("删：") + "delete（ids）。" +
    "<br>" +
    I18n.t(
      "纯文本（非智能）节点：仅得到「【数据库：标题】」指针占位，不注入本库内容，也不调用工具。",
    ) +
    "<br><code>!@" + safeHintTitle + "</code>";
  body.appendChild(hint);
  /* 查询行（FTS5 BM25 + 结构化过滤） */
  const qrow = document.createElement("div");
  qrow.className = "n-db-console-row";
  const qin = document.createElement("input");
  qin.type = "text";
  qin.className = "n-db-console-input";
  qin.placeholder = I18n.t("查询（支持 title: / file: / kind: 过滤）…");
  qin.value = st.q || "";
  const qbtn = document.createElement("button");
  qbtn.type = "button";
  qbtn.className = "mini";
  qbtn.textContent = I18n.t("查询");
  const runQuery = async () => {
    const q = qin.value.trim();
    if (!q) {
      toast(I18n.t("输入查询内容"), "warn");
      return;
    }
    st.q = q;
    const dir = dbNodeDir(node);
    if (!dir) {
      st.results = { error: I18n.t("未设置工作目录/子文件夹，无法查询") };
      renderCanvas();
      return;
    }
    const r = await window.api.dbQuery(dir, q, 6).catch(() => null);
    st.results =
      r && r.ok ? r : { error: (r && r.error) || I18n.t("查询失败") };
    renderCanvas();
  };
  qbtn.onclick = runQuery;
  qin.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runQuery();
  });
  qrow.append(qin, qbtn);
  body.appendChild(qrow);
  /* 结果区（全部带溯源） */
  const res = document.createElement("div");
  res.className = "n-db-console-results";
  if (st.results && st.results.error) {
    res.innerHTML =
      '<div class="n-db-orphan">' + escapeHtml(st.results.error) + "</div>";
  } else if (st.results) {
    if (!st.results.found) {
      res.innerHTML =
        '<div class="n-db-orphan">' +
        escapeHtml(st.results.none || I18n.t("无匹配记录")) +
        "</div>";
    } else {
      for (const h of st.results.results || []) {
        const row = document.createElement("div");
        row.className = "n-db-console-hit";
        row.innerHTML =
          '<div class="n-db-console-hit-head"><span class="n-db-rid">' +
          escapeHtml(h.id) +
          '</span><span class="n-db-rtitle">' +
          escapeHtml(h.title || "") +
          '</span><span class="n-db-rkind">' +
          escapeHtml(h.kind || "") +
          "</span></div>" +
          '<div class="n-db-console-snip">' +
          escapeHtml(h.snippet || "") +
          "</div>" +
          '<div class="n-db-console-src">' +
          escapeHtml(h.source || "") +
          "</div>";
        res.appendChild(row);
      }
    }
  }
  body.appendChild(res);
  /* calc 行（数字计算交给代码） */
  const crow = document.createElement("div");
  crow.className = "n-db-console-row";
  const cin = document.createElement("input");
  cin.type = "text";
  cin.className = "n-db-console-input";
  cin.placeholder = I18n.t("calc：数字 + - * / % ( )");
  const cbtn = document.createElement("button");
  cbtn.type = "button";
  cbtn.className = "mini";
  cbtn.textContent = "calc";
  const calcout = document.createElement("span");
  calcout.className = "n-db-console-calc";
  if (st.calc) calcout.textContent = "= " + st.calc;
  const runCalc = async () => {
    const r = await window.api.dbCalc(cin.value).catch(() => null);
    st.calc =
      r && r.ok ? String(r.value) : (r && r.error) || I18n.t("表达式非法");
    renderCanvas();
  };
  cbtn.onclick = runCalc;
  cin.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runCalc();
  });
  crow.append(cin, cbtn, calcout);
  body.appendChild(crow);
  /* 操作行 */
  const orow = document.createElement("div");
  orow.className = "n-db-console-ops";
  const dirtyBtn = document.createElement("button");
  dirtyBtn.type = "button";
  dirtyBtn.className = "mini";
  dirtyBtn.textContent = I18n.t("检查更新");
  dirtyBtn.onclick = async () => {
    dirtyBtn.textContent = "…";
    const d = await dbDirtyCheck(node);
    st.dirty = d;
    renderCanvas();
  };
  const compileBtn = document.createElement("button");
  compileBtn.type = "button";
  compileBtn.className = "mini";
  compileBtn.textContent = node._dbCompiling ? "…" : I18n.t("编译（增量）");
  compileBtn.onclick = () => compileDbSuper(node);
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "mini";
  openBtn.textContent = I18n.t("打开子文件夹");
  openBtn.onclick = async () => {
    const dir = dbNodeDir(node);
    if (!dir) {
      toast(I18n.t("未设置工作目录/子文件夹"), "warn");
      return;
    }
    await window.api.shellOpenPath(dir).catch(() => {});
  };
  orow.append(dirtyBtn, compileBtn, openBtn);
  body.appendChild(orow);
  /* 检查更新结果 */
  if (st.dirty) {
    const d = st.dirty;
    const dr = document.createElement("div");
    dr.className = "n-db-console-dirty";
    dr.textContent = d.error
      ? d.error
      : I18n.t(
          "待入库：+{a} 新增 · ~{c} 变更 · −{r} 移除（点击「编译（增量）」生效）",
          { a: d.added, c: d.changed, r: d.removed },
        );
    body.appendChild(dr);
  }
}
/* 检查更新（不编译、不读文件内容）：清单 vs 磁盘文件(size+mtime) vs 内部节点哈希 */
async function dbDirtyCheck(node) {
  if (!node || !node.db) return { added: 0, removed: 0, changed: 0, error: "" };
  try {
    const manifest = (node.dbIndex && node.dbIndex.records) || [];
    const added = [],
      removed = [],
      changed = [];
    /* 内部节点：重算候选哈希（便宜） */
    const cur = await collectDbRecords(node);
    const curBySource = new Map(cur.map((r) => [r.source, r]));
    const manBySource = new Map(manifest.map((r) => [r.source, r]));
    for (const [src, r] of curBySource) {
      if (!src.startsWith("node:")) continue;
      const m = manBySource.get(src);
      if (!m) added.push(src);
      else if (m.hash !== r.hash) changed.push(src);
    }
    for (const [src] of manBySource) {
      if (!src.startsWith("node:")) continue;
      if (!curBySource.has(src)) removed.push(src);
    }
    /* 文件：目录列举 vs 清单 size+mtime */
    const dir = dbNodeDir(node);
    if (dir) {
      const lr = await window.api.fileListDir(dir).catch(() => null);
      const disk = new Map();
      if (lr && lr.ok && Array.isArray(lr.list)) {
        for (const f of lr.list) {
          if (!f || !dbTextishFile(f.name)) continue;
          disk.set("file:" + f.rel, { size: f.size, mtime: f.mtime });
        }
      }
      for (const [src, st] of disk) {
        const m = manBySource.get(src);
        if (!m) added.push(src);
        else if (Number(m.size || 0) !== Number(st.size || 0) || Number(m.mtime || 0) !== Number(st.mtime || 0))
          changed.push(src);
      }
      for (const [src, m] of manBySource) {
        if (!src.startsWith("file:")) continue;
        if (!disk.has(src)) removed.push(src);
      }
    }
    return { added: added.length, removed: removed.length, changed: changed.length, error: "" };
  } catch (e) {
    return { added: 0, removed: 0, changed: 0, error: (e && e.message) || String(e) };
  }
}

/* ==========================================================================
   数据库 · 文件节点(input_file) / 表节点(db_table)：批量导入文件并「建表」
   - 文件节点：批量导入任意文件，复制进数据库子文件夹
   - 表节点：读取连入的文件节点 → agent 抽元数据得到表单 → 用户确认 → 按表单建表
   - 非文本文件 → 「文件名」「内容说明」索引；图像 → 询问是否识图，结果填内容说明
   ========================================================================== */
const DB_IMG_EXT = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "ico", "avif", "tif", "tiff",
]);
function dbFileType(name) {
  const s = String(name || "");
  const i = s.lastIndexOf(".");
  if (i <= 0 || i === s.length - 1) return "binary";
  const ext = s.slice(i + 1).toLowerCase();
  if (DB_TEXT_EXT.has(ext)) return "text";
  if (DB_IMG_EXT.has(ext)) return "image";
  return "binary";
}
function dbHumanSize(b) {
  const n = Number(b) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
/* 向上找所属「数据库」超级节点（支持嵌套，取最近一层 db:true） */
function dbSuperOfTable(node) {
  let cur = node;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.kind === "super" && cur.db) return cur;
    cur = cur.parentSuperId ? nodeById(cur.parentSuperId) : null;
  }
  return null;
}
function dbSuperDir(node) {
  return dbNodeDir(dbSuperOfTable(node));
}
function dbTableStem(node) {
  const safe = String(node.title || "表").replace(/[^\w\u4e00-\u9fff-]+/g, "_");
  return "表_" + safe;
}
async function dbPathExists(p) {
  return !!(await window.api.fileExists(p).catch(() => false));
}
async function dbUniqueDest(dir, name) {
  let base = name, ext = "";
  const i = name.lastIndexOf(".");
  if (i > 0) { base = name.slice(0, i); ext = name.slice(i); }
  let p = window.api.pathJoin(dir, name);
  let n = 1;
  while (await dbPathExists(p)) {
    p = window.api.pathJoin(dir, base + "-" + n + ext);
    n++;
  }
  return p;
}
/* 文件节点内单个文件的展示行 + 移除 */
function dbFileRowEl(node, f) {
  const row = document.createElement("div");
  row.className = "db-file-row";
  const ico = document.createElement("span");
  ico.className = "db-file-ico";
  ico.textContent = f.type === "image" ? "🖼" : f.type === "text" ? "📄" : "📦";
  const nm = document.createElement("span");
  nm.className = "db-file-name";
  nm.textContent = f.name || "";
  nm.title = f.path || "";
  const sz = document.createElement("span");
  sz.className = "db-file-size";
  sz.textContent = dbHumanSize(f.size);
  const tp = document.createElement("span");
  tp.className = "db-file-type";
  tp.textContent = f.type;
  const del = document.createElement("button");
  del.className = "mini";
  del.textContent = "✕";
  del.addEventListener("click", () => {
    const i = (node.files || []).indexOf(f);
    if (i >= 0) node.files.splice(i, 1);
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
  });
  row.append(ico, nm, sz, tp, del);
  return row;
}
/* 文件节点：批量导入任意文件 → 复制进数据库子文件夹 */
async function dbImportFiles(node) {
  const dir = dbSuperDir(node);
  if (!dir) {
    toast(I18n.t("未设置工作目录/子文件夹，无法导入文件"), "warn");
    return;
  }
  const r = await window.api.fileOpenDialog({
    title: I18n.t("导入任意文件（可多选）"),
    filters: [],
    multi: true,
  });
  if (!r.paths || !r.paths.length) return;
  const files = node.files || (node.files = []);
  let added = 0;
  for (const p of r.paths) {
    const name = String(p).split(/[\\/]/).pop() || "file";
    const dest = await dbUniqueDest(dir, name);
    await window.api.fileCopyAssetTo(p, dest).catch(() => {});
    const st = await window.api.fileStat(dest).catch(() => null);
    const nf = name;
    files.push({
      id: uid("f"),
      name: String(dest).split(/[\\/]/).pop() || nf,
      path: dest,
      rel: window.api.pathRelative(dir, dest) || nf,
      size: (st && st.size) || 0,
      mtime: (st && st.mtime) || 0,
      type: dbFileType(dest),
    });
    added++;
  }
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已导入 ") + added + I18n.t(" 个文件"), "ok");
}
/* 收集连入的「文件节点」中的文件（向上游递归，含全局广播的 input_file） */
function dbTableConnectedFiles(node) {
  const files = [];
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    if (n.kind === "input_file") {
      for (const f of (n.files || [])) files.push(Object.assign({}, f, { srcNode: n.id }));
    }
    for (const w of (S.wf.wires || [])) {
      if (w.to !== n.id) continue;
      walk(nodeById(w.from));
    }
  };
  walk(node);
  return files;
}
/* 找一个可用的视觉模型（用于图像识图） */
function dbFirstVisionModel() {
  for (const p of mtnodePiProviders()) {
    const vms = visionModelsForProvider("mtnode_" + p.route);
    if (vms.length) return { provider: "mtnode_" + p.route, model: vms[0].id };
  }
  const dp = dshProvider();
  const dvm = dp ? visionModelsForProvider("deepseek-official") : [];
  if (dvm.length) return { provider: "deepseek-official", model: dvm[0].id };
  return null;
}
/* 图像识图：返回内容说明（失败则回退为占位） */
async function dbRecognizeImage(node, absPath) {
  const vis = dbFirstVisionModel();
  const opts = { node, effort: "low", preset: "standard" };
  if (vis) { opts.provider = vis.provider; opts.model = vis.model; }
  try {
    const text = await dshRunTask(
      "请阅读图片并给出内容说明（70 字以内，只输出说明正文，不要前缀或解释）。",
      Object.assign({}, opts, { images: [absPath] }),
    );
    const t = String(text || "").trim().slice(0, 240);
    return t || "(未识别)";
  } catch (_) {
    return "(未识别)";
  }
}
function dbParseColumnsJson(text) {
  const s = String(text || "");
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((c) => ({
        name: String((c && c.name) || "").trim(),
        type: String((c && c.type) || "text").trim() || "text",
        desc: String((c && c.desc) || "").trim(),
      }))
      .filter((c) => c.name);
  } catch (_) {
    return [];
  }
}
function dbParseRowJson(text) {
  const s = String(text || "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const o = JSON.parse(m[0]);
    return o && typeof o === "object" ? o : {};
  } catch (_) {
    return {};
  }
}
/* agent 提议「表」的统一列结构（来自文本文件内容样本） */
async function dbProposeColumns(node, samples) {
  const defCols = [
    { name: "文件名", type: "text", desc: "文件名称" },
    { name: "内容说明", type: "text", desc: "文件内容概要说明" },
  ];
  if (!samples.length) return defCols.slice();
  const brief = samples
    .slice(0, 6)
    .map((s) => "### " + s.name + "\n" + String(s.content || "").slice(0, 3000))
    .join("\n\n");
  const prompt =
    "下面是若干文本文件的内容样本。请为它们提炼一个统一的「表」列结构（字段名、类型、说明），用来把这些文件内容整理成行。只输出一个 JSON 数组，元素形如 {\"name\":\"字段名\",\"type\":\"字段类型\",\"desc\":\"字段说明\"}。列不要超过 8 个，不要输出任何其他文字。\n\n" +
    brief;
  let text = "";
  try {
    text = await dshRunTask(prompt, { node, effort: "high", preset: "standard" });
  } catch (_) {
    text = "";
  }
  const cols = dbParseColumnsJson(text);
  if (!cols.some((c) => /文件名|filename/i.test(c.name))) cols.unshift(defCols[0]);
  if (!cols.some((c) => /内容说明|description/i.test(c.name))) cols.push(defCols[1]);
  return cols.length ? cols : defCols.slice();
}
/* 解析 JSON 数组 [{file, ...}] → { 文件名: {列: 值} } */
function dbParseRowsJson(text) {
  const s = String(text || "");
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return {};
  let arr = null;
  try {
    arr = JSON.parse(m[0]);
  } catch (_) {
    return {};
  }
  if (!Array.isArray(arr)) return {};
  const out = {};
  for (const r of arr) {
    const fn = String((r && (r.file || r._file)) || "").trim();
    if (!fn) continue;
    const obj = {};
    for (const k of Object.keys(r || {})) {
      if (k === "file" || k === "_file") continue;
      obj[k] = r[k];
    }
    out[fn] = obj;
  }
  return out;
}
/* 按字符数把文本文件内容分批：软界 5 万 / 硬界 8 万；截断只在换行处，无换行则以整个文件为单位 */
function dbBuildTextBatches(entries) {
  const SOFT = 50000;
  const HARD = 80000;
  const batches = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
  };
  /* 尝试把 content 放进 budget 内：放得下则整文；放不下则切到最后一个换行；无换行则返回 null（文件为单位） */
  const fit = (content, budget) => {
    if (content.length <= budget) return { content, truncated: false };
    const at = content.lastIndexOf("\n", budget);
    if (at >= 0) return { content: content.slice(0, at + 1), truncated: true };
    return null;
  };
  for (const e of entries) {
    const content = e.content || "";
    let put = fit(content, HARD - curLen);
    if (!put && cur.length) {
      flush();
      put = fit(content, HARD);
    }
    if (!put) {
      /* 批内放不下且无法按换行截断（截断区无换行）→ 以整个文件为单位独占一批 */
      flush();
      put = { content, truncated: true };
    }
    cur.push({ name: e.name, content: put.content, truncated: put.truncated });
    curLen += put.content.length;
    if (curLen >= SOFT) flush();
  }
  flush();
  return batches;
}
/* 用「子代理」按批次批量抽取每行的列值（每批次一次模型调用，自带正确 prompt） */
async function dbExtractRowsBatch(node, columns, batch) {
  const colDescs = columns
    .map((c) => c.name + (c.desc ? "（" + c.desc + "）" : ""))
    .join("，");
  const prompt =
    "你是数据抽取子代理。下面给出若干文本文件的名称与内容（可能因篇幅截断）。请为【每个文件】分别抽取一行，按给定「表」的字段取该文件对应字段的值。" +
    "只输出一个 JSON 数组，每个元素形如 {\"file\":\"文件名\",\"字段名\":\"字段值\"}。键为字段名，值为该文件对应字段的取值；没有的字段可省略，不要臆造。" +
    "元素里的 file 必须与输入中的文件名完全一致。只输出数组，不要任何其他文字。\n\n字段：" +
    colDescs +
    "\n\n" +
    batch
      .map(
        (b) =>
          "### 文件：" +
          b.name +
          (b.truncated ? "（内容因篇幅截断）" : "") +
          "\n" +
          b.content,
      )
      .join("\n\n");
  let text = "";
  try {
    text = await dshRunTask(prompt, { node, effort: "high", preset: "standard" });
  } catch (_) {
    text = "";
  }
  return dbParseRowsJson(text);
}
/* 用户确认表单（列定义）：可增删改；返回列数组，取消返回 null */
function dbAskUserForm(node, columns) {
  return new Promise((resolve) => {
    openOverlay(I18n.t("确认表单（建表元数据）"), { persistent: true });
    const body = $("#ovBody");
    body.classList.add("db-form-body");
    const hint = document.createElement("div");
    hint.className = "db-form-hint";
    hint.textContent = I18n.t(
      "请核对并修正下方字段（列）定义；确认后，所有连入的文件将按此表单建表。",
    );
    body.appendChild(hint);
    const wrap = document.createElement("div");
    wrap.className = "db-form-cols";
    const renderCols = () => {
      wrap.innerHTML = "";
      columns.forEach((c, idx) => {
        const row = document.createElement("div");
        row.className = "db-form-col-row";
        const nameInp = document.createElement("input");
        nameInp.type = "text";
        nameInp.value = c.name;
        nameInp.addEventListener("change", () => { c.name = nameInp.value.trim(); });
        const typeSel = document.createElement("select");
        ["text", "number", "date", "bool"].forEach((t) => {
          const o = document.createElement("option");
          o.value = t;
          o.textContent = t;
          if (c.type === t) o.selected = true;
          typeSel.appendChild(o);
        });
        typeSel.addEventListener("change", () => { c.type = typeSel.value; });
        const descInp = document.createElement("input");
        descInp.type = "text";
        descInp.value = c.desc || "";
        descInp.addEventListener("change", () => { c.desc = descInp.value.trim(); });
        const del = document.createElement("button");
        del.className = "mini";
        del.textContent = "✕";
        del.addEventListener("click", () => { columns.splice(idx, 1); renderCols(); });
        row.append(nameInp, typeSel, descInp, del);
        wrap.appendChild(row);
      });
    };
    renderCols();
    body.appendChild(wrap);
    const addBtn = document.createElement("button");
    addBtn.className = "mini";
    addBtn.textContent = "＋ 添加列";
    addBtn.addEventListener("click", () => {
      columns.push({ name: "新列", type: "text", desc: "" });
      renderCols();
    });
    body.appendChild(addBtn);
    const foot = $("#ovFoot");
    const cancel = document.createElement("button");
    cancel.className = "mini";
    cancel.textContent = I18n.t("取消");
    cancel.addEventListener("click", () => { closeOverlay(); resolve(null); });
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = I18n.t("确认并建表");
    ok.addEventListener("click", () => {
      const cols = columns.filter((c) => c.name.trim());
      closeOverlay();
      resolve(cols);
    });
    foot.append(cancel, ok);
  });
}
function dbCsvCell(s) {
  return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
}
async function dbSaveTable(node, columns, rows) {
  const dir = dbSuperDir(node);
  if (!dir) return;
  const stem = dbTableStem(node);
  const schemaPath = window.api.pathJoin(dir, stem + ".schema.yml");
  const dataPath = window.api.pathJoin(dir, stem + ".table.csv");
  const schemaLines = ["# 表结构（由「表」节点建表生成）", "columns:"];
  for (const c of columns)
    schemaLines.push(
      "  - name: " + JSON.stringify(c.name) + "\n    type: " + c.type + "\n    desc: " + JSON.stringify(c.desc || ""),
    );
  schemaLines.push("rows: " + rows.length);
  await window.api.fileWriteText(schemaPath, schemaLines.join("\n")).catch(() => {});
  const colNames = columns.map((c) => c.name);
  const csvRows = [colNames.join(",")];
  for (const r of rows)
    csvRows.push(colNames.map((cn) => dbCsvCell(r[cn])).join(","));
  await window.api.fileWriteText(dataPath, csvRows.join("\n")).catch(() => {});
  node.schemaFile = schemaPath;
  node.dataFile = dataPath;
  node.builtAt = Date.now();
}
/* 建表主流程 */
async function runDbTableBuild(node) {
  if (!node || node.building) return;
  const files = dbTableConnectedFiles(node).filter((f) => f && f.path);
  if (!files.length) {
    toast(
      I18n.t("请先把「文件节点」连接到本「表」节点，并在文件节点里导入文件"),
      "warn",
    );
    return;
  }
  node.building = true;
  node.error = "";
  renderCanvas();
  try {
    const samples = [];
    const images = [];
    for (const f of files) {
      if (f.type === "text") {
        const rr = await window.api.fileReadText(f.path).catch(() => null);
        const content = rr && rr.ok && rr.exists ? String(rr.content || "") : "";
        if (content) samples.push({ name: f.name, content });
      } else if (f.type === "image") {
        images.push(f);
      }
    }
    /* 图像：询问是否识图，结果填入内容说明 */
    const descMap = {};
    for (const img of images) {
      let want = false;
      try {
        want = confirm(
          I18n.t("图像「{n}」需要内容说明，是否进行识图处理？", { n: img.name }),
        );
      } catch (_) {}
      descMap[img.path] = want ? await dbRecognizeImage(node, img.path) : "(未识别)";
    }
    const columns = await dbProposeColumns(node, samples, images, descMap);
    const form = await dbAskUserForm(node, columns);
    if (!form || !form.length) {
      node.building = false;
      renderCanvas();
      toast(I18n.t("已取消建表"), "warn");
      return;
    }
    /* 按表单建表：每个文件 = 一行 */
    const rows = [];
    const nameCol = form.find((c) => /文件名|filename/i.test(c.name));
    const descCol = form.find((c) => /内容说明|description/i.test(c.name));
    /* 文本文件：先读全量内容，再按字符数分批（软 5 万 / 硬 8 万），用「子代理」逐批抽列值 */
    const textFileMap = new Map(); // f.path -> {file, name, content}
    for (const f of files) {
      if (f.type !== "text") continue;
      const rr = await window.api.fileReadText(f.path).catch(() => null);
      const content = rr && rr.ok && rr.exists ? String(rr.content || "") : "";
      textFileMap.set(f.path, { file: f, name: f.name, content });
    }
    const rowMap = {}; // 文件名 -> {列: 值}
    const batches = dbBuildTextBatches([...textFileMap.values()]);
    for (const batch of batches) {
      const got = await dbExtractRowsBatch(node, form, batch);
      for (const b of batch) {
        if (!got[b.name] || !Object.keys(got[b.name]).length) continue;
        rowMap[b.name] = got[b.name];
      }
    }
    for (const f of files) {
      const row = {};
      if (f.type === "text") {
        const meta = textFileMap.get(f.path);
        const content = meta ? meta.content : "";
        const vals = rowMap[f.name] || {};
        for (const c of form) {
          const v = vals[c.name];
          if (v != null && String(v) !== "") row[c.name] = String(v);
          else if (c === nameCol) row[c.name] = f.name;
          else if (c === descCol) row[c.name] = String(content || "").slice(0, 300);
          else row[c.name] = "";
        }
      } else {
        for (const c of form) {
          if (c === nameCol) row[c.name] = f.name;
          else if (c === descCol)
            row[c.name] = descMap[f.path] || (f.type === "image" ? "(未识别)" : "");
          else row[c.name] = "";
        }
      }
      row._file = f.name;
      rows.push(row);
    }
    await dbSaveTable(node, form, rows);
    node.tableDef = form;
    node.rows = rows;
    node.builtAt = Date.now();
    node.building = false;
    pushHistory();
    scheduleSave(true);
    renderCanvas();
    toast(
      I18n.t("建表完成：{c} 列 · {r} 行", { c: form.length, r: rows.length }),
      "ok",
    );
  } catch (e) {
    node.building = false;
    node.error = (e && e.message) || String(e);
    renderCanvas();
    toast(I18n.t("建表失败：") + node.error, "err");
  }
}

/* ---------- 接线检测：智能节点上游（输入连线，递归）是否接入了数据库副本 ---------- */
function dbReplicaSourcesInWf(node, wf) {
  const nodes = (wf && wf.nodes) || [];
  const wires = (wf && wf.wires) || [];
  const byId = (id) => nodes.find((n) => n.id === id);
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    for (const w of wires) {
      if (w.to !== n.id) continue;
      const src = byId(w.from);
      if (!src) continue;
      if (src.kind === "db_replica") {
        if (!out.some((r) => r.id === src.id)) out.push(src);
      } else {
        walk(src);
      }
    }
  };
  walk(node);
  return out;
}
function dbNodesForInWf(node, wf) {
  const out = [];
  const nodes = (wf && wf.nodes) || [];
  const byId = (id) => nodes.find((n) => n.id === id);
  for (const r of dbReplicaSourcesInWf(node, wf)) {
    const db = byId(r.dbNodeId);
    if (
      db &&
      db.kind === "super" &&
      db.db &&
      db.dbIndex &&
      Array.isArray(db.dbIndex.records) &&
      !out.some((x) => x.id === db.id)
    )
      out.push(db);
  }
  return out;
}

/* 所有已编译的数据库超级节点（供 !@ 引用解析） */
function compiledDbSupers(wf) {
  return ((wf && wf.nodes) || []).filter(
    (n) =>
      n &&
      n.kind === "super" &&
      n.db &&
      n.dbIndex &&
      Array.isArray(n.dbIndex.records),
  );
}
/* 扫描节点本次运行的 prompt/task，找出 !@标题 引用的数据库节点 */
function dbNodesReferencedByBang(node, wf) {
  const p = String(procPromptForRun(node) || "");
  if (!p.includes("!@")) return [];
  const supers = compiledDbSupers(wf);
  if (!supers.length) return [];
  const out = [];
  const seen = new Set();
  const re = /!@([^\s!@，。；、！？：,:!?;:]+)/g;
  let m;
  while ((m = re.exec(p))) {
    const tok = m[1].trim();
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    const db =
      supers.find((s) => s.title === tok) ||
      supers.find((s) => (s.title || "").startsWith(tok));
    if (db && !out.some((x) => x.id === db.id)) out.push(db);
  }
  return out;
}
/* 本节点可访问的数据库 = 连线接入的副本库 + !@ 引用的库 */
function dbNodesForRun(node, wf) {
  const out = dbNodesForInWf(node, wf);
  for (const d of dbNodesReferencedByBang(node, wf)) {
    if (!out.some((x) => x.id === d.id)) out.push(d);
  }
  return out;
}

/* 把 prompt 里的 !@标题 数据库引用替换为可读指针（避免被 @ 正则吃掉），并顺手收集引用库 */
function resolveDbBangRefs(prompt, node) {
  const p = String(prompt || "");
  if (!p.includes("!@")) return { prompt: p, dbs: [] };
  const supers = compiledDbSupers(S.wf);
  const dbs = [];
  const out = p.replace(/!@([^\s!@，。；、！？：,:!?;:]+)/g, (m, tok) => {
    const t = tok.trim();
    if (!t) return m;
    const db =
      supers.find((s) => s.title === t) ||
      supers.find((s) => (s.title || "").startsWith(t));
    if (db) {
      if (!dbs.some((x) => x.id === db.id)) dbs.push(db);
      return I18n.t("【数据库：{t}】", { t: db.title });
    }
    return I18n.t("【数据库：{t}】", { t });
  });
  return { prompt: out, dbs };
}

/* ---------- 宿主侧 mtnode_db 事件处理（工具调用 → SQLite/FTS5 查询 → 应答） ---------- */
function dbNodeDirInWf(db, wf) {
  const ws = String((wf && wf.workspace) || "").trim();
  const sf = String((db && db.subFolder) || "").trim();
  if (!ws || !sf) return "";
  return window.api.pathJoin(ws, sf);
}
async function dbLogToStore(db, wf, node, action, q, hits) {
  const dir = dbNodeDirInWf(db, wf);
  if (!dir) return;
  try {
    await window.api.dbLog(dir, {
      node: (node && node.title) || "",
      action,
      q: String(q || "").slice(0, 200),
      hits: Number(hits) || 0,
    });
  } catch (_) {}
}
async function handleDbToolEvent(data, node, wf) {
  const id = data && data.id;
  const reply = (result) =>
    window.api.dshInteract({ kind: "db", id, result }).catch(() => {});
  if (!id) return;
  try {
    /* 工具参数经网关放在 data.params（帧顶层只有 action） */
    const p = (data && data.params) || {};
    const dbs = dbNodesForRun(node, wf);
    if (!dbs.length) {
      reply({
        ok: false,
        error: I18n.t(
          "当前任务未接入数据库：请先在数据库节点上「编译」，再将该数据库副本节点连到输入端，或在 prompt 中用 !@数据库标题 引用",
        ),
      });
      return;
    }
    /* 可选：用 database 参数把操作限定到某一具体库（否则作用于全部引用库） */
    const target = String((data && data.database) || p.database || "").trim();
    const scope = target
      ? dbs.filter(
          (d) =>
            (d.title || "") === target ||
            (d.title || "").startsWith(target) ||
            (d.dbIndex && d.dbIndex.folder === target),
        )
      : dbs;
    if (target && !scope.length) {
      reply({
        ok: false,
        error: I18n.t("未找到名为「{t}」的数据库。可用的：{list}", {
          t: target,
          list: dbs.map((d) => d.title || "").join("、"),
        }),
      });
      return;
    }
    const action = String(
      (data && data.action) || p.action || "list",
    );
    if (action === "calc") {
      const r = await window.api.dbCalc(p.expr).catch(() => null);
      reply(r || { ok: false, error: I18n.t("calc 失败") });
      return;
    }
    if (action === "write") {
      const rec = (p && (p.records || p.record)) || [];
      /* 给 agent 写入的记录打上溯源 source（非 node:/file: 来源则标记为 agent:），便于持久化与追溯 */
      const records = (Array.isArray(rec) ? rec : [rec])
        .filter(Boolean)
        .map((r0) => {
          const r = { ...r0 };
          const s = String(r.source || "");
          if (!s.startsWith("node:") && !s.startsWith("file:") && !s.startsWith("agent:"))
            r.source = "agent:" + ((node && node.title) || "");
          return r;
        });
      const per = [];
      for (const d of scope) {
        const dir = dbNodeDirInWf(d, wf);
        if (!dir) continue;
        const r = await window.api.dbWrite(dir, records).catch(() => null);
        per.push({
          database: d.title || "",
          ok: !!(r && r.ok),
          ...(r && r.ok ? { written: r.written } : { error: r && r.error }),
        });
      }
      reply({ ok: true, action: "write", databases: per });
      return;
    }
    if (action === "delete") {
      const ids = (p && (p.ids || (p.id ? [p.id] : []))) || [];
      const per = [];
      for (const d of scope) {
        const dir = dbNodeDirInWf(d, wf);
        if (!dir) continue;
        const r = await window.api.dbDelete(dir, ids).catch(() => null);
        per.push({
          database: d.title || "",
          ok: !!(r && r.ok),
          ...(r && r.ok ? { deleted: r.deleted } : { error: r && r.error }),
        });
      }
      reply({ ok: true, action: "delete", databases: per });
      return;
    }
    if (action === "list") {
      const per = [];
      let total = 0;
      for (const d of scope) {
        const dir = dbNodeDirInWf(d, wf);
        if (!dir) {
          per.push({
            database: d.title || "",
            folder: (d.dbIndex && d.dbIndex.folder) || "",
            compiledAt: (d.dbIndex && d.dbIndex.compiledAt) || 0,
            count: 0,
            sql: "",
            provenance: [],
            data: [],
            titles: [],
          });
          continue;
        }
        const r = await window.api.dbList(dir).catch(() => null);
        const list = r && r.ok && Array.isArray(r.records) ? r.records : [];
        total += r && r.ok ? Number(r.count) || list.length : 0;
        per.push({
          database: d.title || "",
          folder: (d.dbIndex && d.dbIndex.folder) || "",
          compiledAt: (d.dbIndex && d.dbIndex.compiledAt) || 0,
          count: list.length,
          sql: (r && r.sql) || "",
          provenance: list.map((x) => ({
            id: x.id,
            title: x.title || "",
            kind: x.kind || "",
            source: x.source || "",
            file: x.file || "",
          })),
          data: list,
          titles: list.slice(0, 200).map(
            (x) =>
              x.id + " | " + (x.title || "") + " | " + (x.kind || "") + (x.file ? " | " + x.file : ""),
          ),
        });
      }
      reply({ ok: true, action: "list", databases: per, total });
      return;
    }
    if (action === "get") {
      const rid = String((data && data.id) || p.id || "");
      for (const d of scope) {
        const dir = dbNodeDirInWf(d, wf);
        if (!dir) continue;
        const r = await window.api.dbGet(dir, rid).catch(() => null);
        if (r && r.ok) {
          dbLogToStore(d, wf, node, "get", rid, 1);
          reply({
            ok: true,
            action: "get",
            database: d.title || "",
            provenance: [
              { id: r.record.id, title: r.record.title, source: r.record.source },
            ],
            sql: r.sql || "",
            data: r.record,
          });
          return;
        }
      }
      reply({ ok: false, error: I18n.t("数据库中没有该记录：") + rid });
      return;
    }
    /* query（FTS5 BM25 排序 + 结构化过滤，读结果带溯源 + SQL + 结构化 JSON） */
    const q = String((data && data.q) || p.q || "").trim();
    if (!q) {
      reply({ ok: false, error: I18n.t("query 需要 q 参数") });
      return;
    }
    const all = [];
    const sqlPer = [];
    for (const d of scope) {
      const dir = dbNodeDirInWf(d, wf);
      if (!dir) continue;
      const r = await window.api.dbQuery(dir, q, 6).catch(() => null);
      if (r && r.ok && Array.isArray(r.results)) {
        if (r.results.length) {
          for (const h of r.results) all.push({ database: d.title || "", ...h });
          sqlPer.push({ database: d.title || "", sql: r.sql || "" });
        }
      }
    }
    const top = all.slice(0, 6);
    /* 按数据库映射本次实际访问语句，便于把 sql 附到每条记录上 */
    const sqlMap = new Map(sqlPer.map((x) => [x.database, x.sql || ""]));
    for (const d of scope) {
      const dir = dbNodeDirInWf(d, wf);
      if (dir) dbLogToStore(d, wf, node, "query", q, top.length);
    }
    reply({
      ok: true,
      action: "query",
      query: q,
      found: top.length,
      provenance: top.map((h) => ({
        id: h.id,
        title: h.title,
        source: h.source,
        kind: h.kind,
        file: h.file,
        database: h.database,
      })),
      /* 访问数据库的语句（SQL / FTS5 查询），按数据库一份 */
      sql: sqlPer,
      /* 结构化输出（JSON 行），每条额外带 sql（该条所在库的访问语句 + 溯源 database） */
      data: top.map((h) => ({ ...h, sql: sqlMap.get(h.database) || "" })),
      ...(top.length === 0
        ? { none: I18n.t("数据库中没有匹配该查询的记录") }
        : {}),
    });
  } catch (e) {
    reply({ ok: false, error: (e && e.message) || String(e) });
  }
}
/* ---------- 提示词接地：接入数据库的智能节点注入事实纪律 ---------- */
function agentDbGroundingNote(node, wf) {
  if (!node) return "";
  const dbs = dbNodesForRun(node, wf);
  if (!dbs.length) return "";
  const names = I18n.listJoin(
    dbs.map((d) => "「" + (d.title || "") + "」(" + (d.dbIndex.records || []).length + I18n.t(" 条") + ")"),
  );
  return [
    "【数据库接入 · 事实强制约束】",
    I18n.t("本任务已接入数据库：") + names + "。",
    I18n.t(
      "1. 一切事实（名称 / 数字 / 价格 / 条款 / 路径）必须通过 mtnode_db 工具查询，回答只陈述工具返回的内容。",
    ),
    I18n.t("2. 每个关键断言都要注明引用来源：[记录id · 标题]。"),
    I18n.t(
      "3. mtnode_db 查不到的事实，必须明确回答「数据库中没有该信息」，禁止猜测、禁止用自身记忆补全。",
    ),
    I18n.t("4. 数字与日期计算必须用 mtnode_db 的 calc 动作，禁止心算。"),
    I18n.t(
      "5. 数据库未记载但任务需要的推断，必须明确标注「此为推断，数据库未记载」。",
    ),
    I18n.t(
      "6. mtnode_db 读取（查）：list / get / query 返回结构化数据——provenance 为溯源（记录 id/标题/来源），sql 为实际访问数据库的语句，data 为输出的记录（JSON 数组）。",
    ),
    I18n.t(
      "7. 增 / 改：用 mtnode_db 的 write，records 为记录数组，每条含 title、content（可带 id / kind / source / file）；未带 id 会自动生成新 id（=新增一条），带了已存在的 id 则覆盖该条（=修改）。写入的记录会以 source=agent: 标记并持久保存，不会被后续编译清除。写前请先 query 确认，避免重复。",
    ),
    I18n.t(
      "8. 删：用 mtnode_db 的 delete，ids 为要删除的记录 id 数组（取自 provenance 的 id）。",
    ),
  ].join("\n");
}

/* 运行一次 agent 任务；返回最终文本。onEvent(type, data) 观察流式事件。 */
function dshRunTask(input, opts) {
  opts = opts || {};
  const sup = dshSupported();
  if (!sup.ok) return Promise.reject(new Error(sup.reason));
  const d = (S.config && S.config.dsh) || {};
  const piProvs = mtnodePiProviders();
  const provider = opts.provider || "deepseek-official";
  const routeModels = agentModelsForRoute(provider);
  if (routeModels.length && !String(opts.model || "").trim()) {
    opts.model = routeModels[0];
  }
  /* 对话路由密钥；联网搜索固定走 DeepSeek Anthropic 端点，需单独注入官方 Key */
  const dsProv = dshProvider();
  let apiKey = (dsProv && dsProv.apiKey) || "";
  let baseUrl = (dsProv && dsProv.baseUrl) || "";
  if (provider !== "deepseek-official") {
    const mp = piProvs.find((x) => "mtnode_" + x.route === provider);
    if (mp) {
      apiKey = mp.apiKey;
      baseUrl = mp.baseUrl;
    } else {
      /* pi-ai 目录路由:需在引擎 settings.yaml 配置 profile,否则报 MISSING_CREDENTIAL */
      apiKey = "";
      baseUrl = "";
    }
  }
  const webSearchApiKey =
    String((dsProv && dsProv.apiKey) || "").trim() ||
    (provider === "deepseek-official" ? String(apiKey || "").trim() : "");
  return Promise.resolve()
    .then(async () => {
      let ws = String(opts.workspace || dshWorkspaceOf(opts.node) || "").trim();
      if (ws && typeof pathIsExistingDir === "function") {
        if (!(await pathIsExistingDir(ws))) {
          await wipeMatchingWorkspaces(ws);
          ws = String(dshWorkspaceOf(opts.node) || "").trim();
          if (ws && !(await pathIsExistingDir(ws))) ws = "";
          toast(I18n.t("工作目录无效，已改用默认目录"), "warn");
        }
      }
      return ws || S.dshWorkspaceFallback || "";
    })
    .then(async (workspace) => {
  const indexBlock = await mtnodeInternalSkillIndexBlock();
  const nodeLock = isCanvasScopedAgentNode(opts.node);
  const runParams = {
    workspace,
    input: String(input || ""),
    model: opts.model || d.model || "deepseek-v4-flash",
    maxTokens: (() => {
      const t = effectiveDshMaxTokens(d.maxTokens);
      return t > 0 ? t : undefined;
    })(),
    apiKey,
    baseUrl,
    webSearchApiKey,
    systemPrompt: [
      opts.systemPrompt || "",
      indexBlock,
      agentDbGroundingNote(opts.node, S.wf),
      agentToolPolicySystemNote({ nodeLock }),
      nodeLock ? agentNodeCapabilityNote() : "",
      opts.planMode ? planModeSystemNote() : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    preset: (() => {
      const p = opts.preset || d.preset || "standard";
      return nodeLock && p === "standard" ? "node" : p;
    })(),
    effort: dshEffortOf(opts.effort, !!(opts.node && opts.node.kind === "proc_text")),
    provider,
    mtnodeProviders: piProvs,
    permissionPreset: resolveNodePermissionPreset(opts.node, d),
    /* 图像输入(绝对路径,网关写入附件库后随消息发给视觉模型) */
    images:
      Array.isArray(opts.images) && opts.images.length
        ? opts.images.slice()
        : undefined,
  };
  /* 并行运行:取消句柄按 runKey 隔离(会话=agent:<id>,节点=node.id,助手=assist) */
  const runKey = String(opts.runKey || (opts.node && opts.node.id) || "default");
  S._runCancels = S._runCancels || {};
  S._runCancels[runKey] = {
    workspace: runParams.workspace,
    model: runParams.model,
    maxTokens: runParams.maxTokens,
    apiKey: runParams.apiKey,
    baseUrl: runParams.baseUrl,
  };
  const t0 = Date.now();
  /* 交互面板:仅首个 run 清空,后续 run 保留其他会话/节点在途的提问与审批 */
  if (!(S._runCount || 0)) ixReset();
  S._runCount = (S._runCount || 0) + 1;
  if (opts.node && isAgentSuperPerm(opts.node) && opts.node.agentPermOutside === "ask") {
    if (S._agentPermSessionPaths) delete S._agentPermSessionPaths[opts.node.id];
  }
  /* 绑定本次运行的画布：后续 canvas 事件写入该 wf，切画布也不会串到别的画布 */
  const boundWf = S.wf;
  beginCanvasRun(boundWf);
  const scopeLock = nodeLock;
  if (scopeLock) S._canvasNodeAgentDepth = (S._canvasNodeAgentDepth || 0) + 1;
  if (opts.node && boundWf) {
    S.nodeWfId = S.nodeWfId || {};
    S.nodeWfId[opts.node.id] = boundWf.id;
    rememberWf(boundWf);
  }
  /* 节点级工具轨迹(思考弹窗展开查看参数/结果) */
  if (opts.node) {
    S.nodeTools = S.nodeTools || {};
    S.nodeTools[opts.node.id] = [];
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let seenError = "";
    /* SDK finalResponse 只含最后一条 assistant 正文;累计全部 text-delta 才是完整输出 */
    let accText = "";
    const finish = (ok, val) => {
      if (settled) return;
      settled = true;
      if (S._runCancels) delete S._runCancels[runKey];
      S._runCount = Math.max(0, (S._runCount || 1) - 1);
      if (!S._runCount) ixDropRun();
      endCanvasRun(boundWf);
      if (scopeLock)
        S._canvasNodeAgentDepth = Math.max(
          0,
          (S._canvasNodeAgentDepth || 1) - 1,
        );
      if (ok) resolve(val);
      else reject(val instanceof Error ? val : new Error(String(val || "")));
    };
    window.api
      .dshRun(
        runParams,
        (msg) => {
          if (msg.type === "canvas") {
            handleCanvasEvent(msg.data || {}, { planMode: !!opts.planMode });
            return;
          }
          if (msg.type === "db") {
            handleDbToolEvent(msg.data || {}, opts.node, boundWf);
            return;
          }
          if (settled) return;
          if (msg.type === "error" && msg.data && msg.data.message) seenError = msg.data.message;
          if (msg.type === "approval") {
            const node = opts.node;
            if (
              node &&
              isAgentSuperPerm(node) &&
              node.agentPermOutside === "ask"
            ) {
              handleSuperAskApproval(node, msg.data || {}, workspace).then(
                (handled) => {
                  if (!handled) ixPush("approval", msg.data || {});
                },
              );
              return;
            }
            ixPush("approval", msg.data || {});
            return;
          }
          if (msg.type === "question") {
            ixPush(msg.type, msg.data || {});
          }
          if (msg.type === "text" && msg.data && msg.data.text)
            accText += msg.data.text;
          if (opts.node && (msg.type === "tool" || msg.type === "tool-result")) {
            const list = S.nodeTools && S.nodeTools[opts.node.id];
            if (list && msg.data) {
              if (msg.type === "tool" && msg.data.name) {
                if (!list.some((x) => x.callId === msg.data.callId))
                  list.push({
                    callId: msg.data.callId,
                    turn: msg.data.turn,
                    step: msg.data.step,
                    name: msg.data.name,
                    args: msg.data.args || "",
                    result: null,
                    error: null,
                    at: Date.now(),
                  });
                /* agent 用 todo_write 建的任务清单：节点内运行也镜像到它绑定的会话面板 */
                if (
                  /todo/i.test(String(msg.data.name || "")) &&
                  opts.node.agentSessionId
                ) {
                  const sess = agentSessions().find(
                    (s) => s.id === opts.node.agentSessionId,
                  );
                  if (sess) agentApplyTodoWrite(sess, msg.data.args);
                }
              } else if (msg.type === "tool-result" && msg.data.callId) {
                const t = list.find((x) => x.callId === msg.data.callId);
                if (t) {
                  t.result = Array.isArray(msg.data.content) ? msg.data.content : [];
                  t.error = msg.data.error || null;
                }
              }
            }
          }
          if (opts.onEvent) {
            try { opts.onEvent(msg.type, msg.data || {}); } catch {}
          }
          if (msg.type === "done") {
            /* 完成音效:仅当任务实际运行超过 5 分钟 */
            if (Date.now() - t0 >= 300000) playTaskDoneSound();
            const data = msg.data || {};
            if (opts.onDone) {
              try { opts.onDone(data); } catch {}
            }
            /* 网关常先 emit error 再 done(空正文);不可吞掉 seenError 当成成功空回复 */
            if (seenError) {
              finish(false, new Error(String(seenError)));
            } else {
              finish(true, String(accText || data.finalResponse || ""));
            }
          }
        }
      )
      .then((res) => {
        if (res && res.ok === false && !settled) {
          finish(false, new Error(res.error || I18n.t("智能能力启动失败")));
        }
      })
      .catch((e) => {
        if (!settled) {
          finish(
            false,
            new Error(seenError || (e && e.message) || String(e)),
          );
        }
      });
  });
    });
}

/* 智能任务节点正在跑、且已关联到该会话时,会话页应镜像节点的流式日志 */
function liveNodeForSession(st) {
  if (!st || !st.id) return null;
  const scan = (wf) => {
    if (!wf || !Array.isArray(wf.nodes)) return null;
    for (const n of wf.nodes) {
      if (n.kind === "agent_task" && n.running && n.agentSessionId === st.id)
        return n;
    }
    return null;
  };
  return (
    scan(S.wf) ||
    Object.keys(S.wfBag || {})
      .map((id) => scan(S.wfBag[id]))
      .find(Boolean) ||
    null
  );
}
function sessionIsRunning(st) {
  return !!(st && (st.running || liveNodeForSession(st)));
}
/* 是否存在任一智能会话在运行(并行会话互不干扰,仅用于画布确认/保存锁定/运行指示) */
function anyAgentSessionRunning() {
  return agentSessions().some((s) => sessionIsRunning(s));
}

function refreshLiveDshOutTools(node) {
  if (!node) return;
  const owner = ownerWfOfNode(node);
  if (!(owner && S.wf && owner.id === S.wf.id)) return;
  const tools = (S.nodeTools && S.nodeTools[node.id]) || [];
  const fill = (box) => {
    if (!box) return;
    box.innerHTML = "";
    for (const t of tools) box.appendChild(dshToolDetailsEl(t, true, node.id));
  };
  fill(document.getElementById("dsh-out-tools-" + node.id));
  fill(document.getElementById("agent-node-tools-" + node.id));
  autoFitOutputHeight(node);
  scrollAgentConv(node);
}

/* 节点智能运行的流式事件:右侧 Output + 已打开的关联智能会话同步刷新 */
function onDshNodeEvent(node, attemptT, type, data) {
  if (!node) return;
  if (type === "reasoning" && data.text)
    pushThinking(node.id, attemptT || 0, data.text);
  else if (type === "tool" && data.name)
    pushThinking(node.id, attemptT || 0, "🔧 " + data.name + "\n");
  const owner = ownerWfOfNode(node);
  const viewing = !!(owner && S.wf && owner.id === S.wf.id);
  if (type === "text" && data.text) {
    node._pendingAnswer = (node._pendingAnswer || "") + data.text;
    if (viewing) {
      const el = document.getElementById("dsh-out-stream-" + node.id);
      if (el) {
        el.classList.remove("n-empty");
        el.textContent = node._pendingAnswer;
      }
      const nel = document.getElementById("agent-node-stream-" + node.id);
      if (nel) nel.textContent = node._pendingAnswer;
      autoFitOutputHeight(node);
      scrollAgentConv(node);
    }
  }
  if (type === "error" && data && data.message) {
    if (node._aborted || isCancelishError(data.message)) return;
    const errLine = "\n⚠ " + data.message;
    node._pendingAnswer = (node._pendingAnswer || "") + errLine;
    pushThinking(node.id, attemptT || 0, errLine + "\n");
    if (viewing) {
      const el = document.getElementById("dsh-out-stream-" + node.id);
      if (el) {
        el.classList.remove("n-empty");
        el.textContent = node._pendingAnswer;
      }
      const nel = document.getElementById("agent-node-stream-" + node.id);
      if (nel) nel.textContent = node._pendingAnswer;
      autoFitOutputHeight(node);
      scrollAgentConv(node);
    }
  }
  if (type === "reasoning" && viewing) {
    const think = document.getElementById("agent-node-think-" + node.id);
    if (think) think.textContent = thinkingTextOf(node) || "";
  }
  if (type === "tool" || type === "tool-result") refreshLiveDshOutTools(node);
  if (node.kind !== "agent_task" || !node.agentSessionId) return;
  if (S.view !== "agent") return;
  const st = agentSessionState();
  if (!st || st.id !== node.agentSessionId) return;
  if (type === "tool" || type === "tool-result") {
    renderAgentSession();
    return;
  }
  const thinkEl = document.getElementById("agent-think");
  const streamEl = document.getElementById("agent-stream");
  if (!thinkEl && !streamEl) {
    renderAgentSession();
    return;
  }
  if (thinkEl) updateAgentThinkEl(st, node);
  if (streamEl) streamEl.textContent = node._pendingAnswer || "";
  const list = $("#agentList");
  scrollElToBottomIfStuck(list);
}

/* ── 任务完成音效:优先自定义音频文件,否则内置短促双音 ── */
function builtinDoneChime() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  S._audioCtx = S._audioCtx || new AC();
  const ac = S._audioCtx;
  if (ac.state === "suspended") ac.resume().catch(() => {});
  const t0 = ac.currentTime;
  [
    [659.25, 0],
    [880, 0.18],
  ].forEach(([f, off]) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + off);
    g.gain.exponentialRampToValueAtTime(0.14, t0 + off + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t0 + off);
    o.stop(t0 + off + 0.18);
  });
}
/* 提问/审批提示音:内置短促双音(440→660),或用自定义文件 */
function builtinIxBeep() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  S._audioCtx = S._audioCtx || new AC();
  const ac = S._audioCtx;
  if (ac.state === "suspended") ac.resume().catch(() => {});
  const t0 = ac.currentTime;
  [
    [440, 0],
    [660, 0.14],
  ].forEach(([f, off]) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + off);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + off + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.12);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t0 + off);
    o.stop(t0 + off + 0.14);
  });
}
function playIxSound() {
  const d = (S.config && S.config.dsh) || {};
  if (d.askSound === false) return;
  if (!playDoneSoundFile(d.askSoundFile || "")) builtinIxBeep();
}
function playDoneSoundFile(file) {
  if (!file) return false;
  try {
    const a = new Audio(window.api.toFileUrl(file));
    a.volume = 0.5;
    a.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
function playTaskDoneSound() {
  const d = (S.config && S.config.dsh) || {};
  if (d.doneSound === false) return;
  const file = d.doneSoundFile || "";
  if (!playDoneSoundFile(file)) builtinDoneChime();
}
/* 设置内试听:忽略 5 分钟限制与开关(用户主动点击) */
function previewDoneSound(file) {
  if (!playDoneSoundFile(file)) builtinDoneChime();
}

/* ── 交互面板:dsh 提问(ask_user)/ 审批(approval)的宿主侧 UI ── */
function ixReset() {
  S.activeIx = { items: [] };
  renderIxPanel();
}
function ixPush(kind, data) {
  if (!S.activeIx) S.activeIx = { items: [] };
  S.activeIx.items.push({ kind, data });
  playIxSound();
  renderIxPanel();
}
function ixDrop(id) {
  if (!S.activeIx) return;
  S.activeIx.items = S.activeIx.items.filter((x) => x.data.id !== id);
  renderIxPanel();
}
function ixDropRun() {
  if (S.activeIx && S.activeIx.items.length) {
    S.activeIx.items = [];
    renderIxPanel();
  }
}
function ixAnswerQuestion(it) {
  const card = document.getElementById("ixCard_" + it.data.id);
  if (!card) return;
  const byQ = {};
  for (const inp of card.querySelectorAll("input")) {
    if (!inp.dataset.qid) continue;
    (byQ[inp.dataset.qid] = byQ[inp.dataset.qid] || []).push(inp);
  }
  const answers = [];
  for (const q of (it.data && it.data.questions) || []) {
    const inputs = byQ[q.id] || [];
    const selected = [];
    let custom;
    for (const inp of inputs) {
      if (inp.type === "text") {
        if (inp.value.trim()) custom = inp.value.trim();
      } else if (inp.checked) {
        selected.push(inp.value);
      }
    }
    answers.push({ id: q.id, selected, ...(custom ? { custom } : {}) });
  }
  window.api
    .dshInteract({ kind: "question", id: it.data.id, answers })
    .then((res) => {
      if (res && res.ok === false) throw new Error(res.error);
      ixDrop(it.data.id);
    })
    .catch((e) => toast(I18n.t("回答失败：") + (e.message || String(e)), "err"));
}
function ixAnswerApproval(it, outcome) {
  window.api
    .dshInteract({ kind: "approval", id: it.data.id, outcome })
    .then((res) => {
      if (res && res.ok === false) throw new Error(res.error);
      ixDrop(it.data.id);
    })
    .catch((e) => toast(I18n.t("审批失败：") + (e.message || String(e)), "err"));
}
function renderIxPanel() {
  const items = (S.activeIx && S.activeIx.items) || [];
  let box = $("#ixPanel");
  if (!items.length) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "ixPanel";
    document.body.appendChild(box);
  }
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ix-head";
  head.textContent = I18n.t("🐋 模型等待你的回应（") + items.length + I18n.t(" 项）");
  box.appendChild(head);
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "ix-card";
    card.id = "ixCard_" + it.data.id;
    if (it.kind === "approval") {
      const d = it.data;
      const t1 = document.createElement("div");
      t1.className = "ix-title";
      t1.textContent = I18n.t("🔐 权限审批 · ") + (d.toolName || I18n.t("工具"));
      card.appendChild(t1);
      if (d.reason) {
        const r = document.createElement("div");
        r.className = "ix-detail";
        r.textContent = d.reason;
        card.appendChild(r);
      }
      const row = document.createElement("div");
      row.className = "ix-btns";
      const allow = document.createElement("button");
      allow.className = "mini primary";
      allow.textContent = I18n.t("允许一次");
      allow.onclick = () => ixAnswerApproval(it, "allowed-once");
      const deny = document.createElement("button");
      deny.className = "mini danger";
      deny.textContent = I18n.t("拒绝");
      deny.onclick = () => ixAnswerApproval(it, "rejected");
      row.appendChild(allow);
      row.appendChild(deny);
      card.appendChild(row);
    } else {
      const d = it.data;
      const qs = d.questions || [];
      for (const q of qs) {
        const qt = document.createElement("div");
        qt.className = "ix-q";
        qt.textContent = (q.header ? q.header + " · " : "") + (q.question || "");
        card.appendChild(qt);
        if (q.detail) {
          const det = document.createElement("div");
          det.className = "ix-detail";
          det.textContent = q.detail;
          card.appendChild(det);
        }
        const opts = q.options || [];
        if (opts.length) {
          const ol = document.createElement("div");
          ol.className = "ix-opts";
          for (const o of opts) {
            const lab = document.createElement("label");
            lab.className = "ix-opt";
            const cb = document.createElement("input");
            cb.type = q.multiSelect ? "checkbox" : "radio";
            cb.name = "ix_" + q.id;
            cb.value = o.label;
            cb.dataset.qid = q.id;
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(o.label));
            if (o.description) lab.title = o.description;
            ol.appendChild(lab);
          }
          card.appendChild(ol);
        }
        const custom = document.createElement("input");
        custom.type = "text";
        custom.className = "ix-custom";
        custom.placeholder = I18n.t("其他（自定义回答，选填）");
        custom.dataset.qid = q.id;
        card.appendChild(custom);
      }
      const row = document.createElement("div");
      row.className = "ix-btns";
      const submit = document.createElement("button");
      submit.className = "mini primary";
      submit.textContent = I18n.t("回答");
      submit.onclick = () => ixAnswerQuestion(it);
      row.appendChild(submit);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
}

/* ── 主题(dsh = 默认, industrial = 旧 MTNode, light = 亮色) ── */
const THEMES = {
  dsh: {
    name: "DSH（默认）",
    cyan: "#5686fe", cyan2: "#7ca2fe", orange: "#ff8f2e", orange2: "#ffb066",
    green: "#5fd68a", red: "#ff5f56",
  },
  industrial: {
    name: "Industrial（旧）",
    cyan: "#38d6ff", cyan2: "#7ce8ff", orange: "#ff8f2e", orange2: "#ffb066",
    green: "#5fd68a", red: "#ff5f56",
  },
  light: {
    name: "Light（亮色）",
    cyan: "#2068b8", cyan2: "#15508f", orange: "#d9660a", orange2: "#b54f04",
    green: "#1a8a4a", red: "#cf2a1e",
  },
};
function applyTheme(name) {
  const t = THEMES[name] || THEMES.dsh;
  const theme = THEMES[name] ? name : "dsh";
  S.config.theme = theme;
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle("theme-industrial", theme === "industrial");
  document.body.classList.toggle("theme-light", theme === "light");
  let el = $("#themeStyle");
  if (!el) {
    el = document.createElement("style");
    el.id = "themeStyle";
    document.head.appendChild(el);
  }
  el.textContent =
    ":root{--cyan:" + t.cyan + ";--cyan2:" + t.cyan2 +
    ";--orange:" + t.orange + ";--orange2:" + t.orange2 +
    ";--green:" + t.green + ";--red:" + t.red + "}";
  window.api.configSave(S.config).catch(() => {});
  if (S.view === "agent") renderAgentSession();
}

/* dsh 任务节点判定：智能任务节点，或开启智能模式的文本处理节点 */
function isDshTask(n) {
  return !!(n && (n.kind === "agent_task" || (n.kind === "proc_text" && n.agent)));
}

function isAgentSuperPerm(n) {
  return !!(isDshTask(n) && n.agentPerm === "super");
}

function normalizeAgentPermOutside(v) {
  return v === "ask" || v === "direct" ? v : "";
}

/** 本节点本次运行应使用的 dsh permissionPreset */
function resolveNodePermissionPreset(node, d) {
  d = d || {};
  if (isAgentSuperPerm(node)) {
    return node.agentPermOutside === "ask"
      ? "mtnode-super-ask"
      : "danger-full-access";
  }
  return d.permissionPreset || "mtnode-unattended";
}

function normFsPath(p) {
  let s = String(p || "").trim().replace(/\//g, "\\");
  if (!s) return "";
  if (/^[a-zA-Z]:\\/.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.replace(/\\+$/, "");
}

function pathUnderRoot(target, root) {
  const t = normFsPath(target).toLowerCase();
  const r = normFsPath(root).toLowerCase();
  if (!t || !r) return false;
  return t === r || t.startsWith(r + "\\");
}

function extractPathsFromText(text) {
  const s = String(text || "");
  const out = [];
  const re =
    /(?:[a-zA-Z]:\\|\\\\[^\\\s"'<>|]+)[^\s"'<>|]*/g;
  let m;
  while ((m = re.exec(s))) {
    let p = m[0].replace(/[),.;]+$/, "");
    if (p.length >= 3) out.push(normFsPath(p));
  }
  return out;
}

function extractPathsFromToolArgs(args) {
  const out = [];
  if (args == null) return out;
  let obj = args;
  if (typeof args === "string") {
    const s = args.trim();
    try {
      if (s.startsWith("{") || s.startsWith("[")) obj = JSON.parse(s);
      else {
        out.push(...extractPathsFromText(s));
        return out;
      }
    } catch {
      out.push(...extractPathsFromText(s));
      return out;
    }
  }
  const walk = (v, key) => {
    if (v == null) return;
    if (typeof v === "string") {
      const k = String(key || "").toLowerCase();
      if (
        /path|file|dir|cwd|folder|workspace|target|src|dest|destination/.test(k) ||
        /^[a-zA-Z]:\\/.test(v) ||
        v.startsWith("\\\\")
      ) {
        out.push(...extractPathsFromText(v));
        if (/^[a-zA-Z]:\\|^\\\\/.test(v.trim())) out.push(normFsPath(v.trim()));
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, key || i));
      return;
    }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v)) walk(val, k);
    }
  };
  walk(obj, "");
  return [...new Set(out.filter(Boolean))];
}

function agentPermSessionPaths(nodeId) {
  if (!S._agentPermSessionPaths) S._agentPermSessionPaths = {};
  if (!S._agentPermSessionPaths[nodeId]) S._agentPermSessionPaths[nodeId] = [];
  return S._agentPermSessionPaths[nodeId];
}

function pathAllowedByList(path, list) {
  const p = normFsPath(path);
  if (!p) return false;
  for (const root of list || []) {
    if (pathUnderRoot(p, root)) return true;
  }
  return false;
}

function pickOutsidePathRoot(paths, workspace) {
  const ws = normFsPath(workspace);
  for (const p of paths || []) {
    if (ws && pathUnderRoot(p, ws)) continue;
    return p;
  }
  return "";
}

function confirmAgentOutsideMode() {
  return new Promise((resolve) => {
    openOverlay(I18n.t("超级权限 · 外部路径策略"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent = I18n.t(
      "已开启超级权限：Agent 可访问本机任意位置（用于辅助编程等高级任务）。首次请选择访问工作区以外路径时的策略：",
    );
    body.appendChild(p);
    const note = document.createElement("div");
    note.style.cssText = "color:var(--muted); font-size:12px; line-height:1.6";
    note.textContent = I18n.t(
      "「是否允许访问」：每次触及未授权的外部路径时弹窗确认（可拒绝 / 允许一次 / 始终允许该路径及子路径）。「直接访问」：不再询问。",
    );
    body.appendChild(note);
    foot.innerHTML = "";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeOverlay();
      resolve(v);
    };
    const cancel = document.createElement("button");
    cancel.className = "mini";
    cancel.textContent = I18n.t("取消");
    cancel.onclick = () => finish(null);
    const ask = document.createElement("button");
    ask.className = "mini primary";
    ask.textContent = I18n.t("是否允许访问");
    ask.onclick = () => finish("ask");
    const direct = document.createElement("button");
    direct.className = "mini";
    direct.textContent = I18n.t("直接访问");
    direct.onclick = () => finish("direct");
    foot.appendChild(cancel);
    foot.appendChild(direct);
    foot.appendChild(ask);
  });
}

function confirmAgentOutsidePath(params) {
  params = params || {};
  return new Promise((resolve) => {
    openOverlay(I18n.t("允许访问外部路径？"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent = I18n.t(
      "超级权限节点请求访问工作区以外的路径。请选择是否允许该路径及其子路径。",
    );
    body.appendChild(p);
    const detail = document.createElement("div");
    detail.style.cssText =
      "color:var(--muted); font-size:12px; margin-bottom:8px; white-space:pre-wrap; word-break:break-all";
    const path = String(params.path || "").trim();
    const tool = String(params.toolName || "").trim();
    const reason = String(params.reason || "").trim();
    detail.textContent =
      (path ? I18n.t("路径：") + path + "\n" : "") +
      (tool ? I18n.t("工具：") + tool + "\n" : "") +
      (reason && reason !== path ? I18n.t("说明：") + reason.slice(0, 600) : "");
    body.appendChild(detail);
    const note = document.createElement("div");
    note.style.cssText = "margin-top:6px; color:var(--orange2); font-size:11.5px";
    note.textContent = I18n.t(
      "「始终允许」写入本节点；「允许一次」仅本次运行有效；「拒绝」则阻止本次调用。",
    );
    body.appendChild(note);
    foot.innerHTML = "";
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      closeOverlay();
      resolve(outcome);
    };
    const deny = document.createElement("button");
    deny.className = "mini danger";
    deny.textContent = I18n.t("拒绝");
    deny.onclick = () => finish("deny");
    const once = document.createElement("button");
    once.className = "mini";
    once.textContent = I18n.t("允许一次");
    once.onclick = () => finish("once");
    const always = document.createElement("button");
    always.className = "mini primary";
    always.textContent = I18n.t("始终允许");
    always.onclick = () => finish("always");
    foot.appendChild(deny);
    foot.appendChild(once);
    foot.appendChild(always);
  });
}

async function toggleAgentNodePerm(node) {
  if (!isDshTask(node)) return;
  if (node.agentPerm === "super") {
    pushHistory();
    node.agentPerm = "canvas";
    scheduleSave();
    renderCanvas();
    toast(I18n.t("已切换为画布权限（工作区沙箱）"), "ok");
    return;
  }
  let outside = normalizeAgentPermOutside(node.agentPermOutside);
  if (!outside) {
    const pick = await confirmAgentOutsideMode();
    if (!pick) return;
    outside = pick;
  }
  pushHistory();
  node.agentPerm = "super";
  node.agentPermOutside = outside;
  if (!Array.isArray(node.agentPermAlwaysPaths)) node.agentPermAlwaysPaths = [];
  scheduleSave();
  renderCanvas();
  toast(
    outside === "ask"
      ? I18n.t("已开启超级权限（外部路径将询问）")
      : I18n.t("已开启超级权限（外部路径直接访问）"),
    "ok",
  );
}

function agentPermButtonEl(node) {
  const btn = document.createElement("button");
  btn.type = "button";
  const superOn = isAgentSuperPerm(node);
  btn.className = "n-agent-perm" + (superOn ? " on" : "");
  btn.textContent = superOn ? I18n.t("超级") : I18n.t("画布");
  const outside = normalizeAgentPermOutside(node.agentPermOutside);
  btn.title = superOn
    ? I18n.t("超级权限：可访问全主机") +
      (outside === "ask"
        ? I18n.t(" · 外部路径询问")
        : I18n.t(" · 外部路径直接访问")) +
      I18n.t("（点击切回画布权限）")
    : I18n.t("画布权限：工作区沙箱（点击开启超级权限）");
  btn.onclick = (ev) => {
    ev.stopPropagation();
    toggleAgentNodePerm(node);
  };
  return btn;
}

async function handleSuperAskApproval(node, data, workspace) {
  if (!isAgentSuperPerm(node) || node.agentPermOutside !== "ask") return false;
  const id = data && data.id;
  if (!id) return false;
  const toolName = String((data && (data.toolName || data.name)) || "");
  const reason = String((data && data.reason) || "");
  const callId = data && data.callId;
  let paths = extractPathsFromText(reason);
  if (callId && S.nodeTools && S.nodeTools[node.id]) {
    const hit = S.nodeTools[node.id].find((t) => t.callId === callId);
    if (hit) paths = paths.concat(extractPathsFromToolArgs(hit.args));
  }
  paths = [...new Set(paths.map(normFsPath).filter(Boolean))];
  const ws = normFsPath(workspace);
  const outside = paths.filter((p) => !(ws && pathUnderRoot(p, ws)));
  const answer = (outcome) =>
    window.api
      .dshInteract({ kind: "approval", id, outcome })
      .catch(() => {});

  if (!outside.length) {
    /* 能判定为工作区内，或完全抽不出路径：工作区内 / 非路径工具自动放行。
       若工具名像文件/终端且无路径可读，仍弹窗以免静默越权。 */
    const risky =
      !paths.length &&
      /bash|pwsh|shell|fs|file|write|edit|read|glob|grep|str_replace|powershell/i.test(
        toolName,
      );
    if (!risky) {
      await answer("allowed-once");
      return true;
    }
    const outcome = await confirmAgentOutsidePath({
      path: "",
      toolName,
      reason: reason || I18n.t("未能解析具体路径，请根据工具与说明判断是否放行。"),
    });
    if (outcome === "deny") await answer("rejected");
    else await answer("allowed-once");
    return true;
  }
  const always = node.agentPermAlwaysPaths || [];
  const session = agentPermSessionPaths(node.id);
  if (outside.every((p) => pathAllowedByList(p, always) || pathAllowedByList(p, session))) {
    await answer("allowed-once");
    return true;
  }
  const root = pickOutsidePathRoot(outside, ws) || outside[0];
  const outcome = await confirmAgentOutsidePath({
    path: root,
    toolName,
    reason,
  });
  if (outcome === "always") {
    if (!Array.isArray(node.agentPermAlwaysPaths)) node.agentPermAlwaysPaths = [];
    const n = normFsPath(root);
    if (n && !node.agentPermAlwaysPaths.some((x) => normFsPath(x) === n)) {
      node.agentPermAlwaysPaths.push(n);
      scheduleSave();
    }
    await answer("allowed-once");
  } else if (outcome === "once") {
    const n = normFsPath(root);
    if (n && !pathAllowedByList(n, session)) session.push(n);
    await answer("allowed-once");
  } else {
    await answer("rejected");
  }
  return true;
}

/* 任务文本(智能任务节点用 task 字段,文本处理用 prompt 字段) */
function procPromptOf(n) {
  /* 仅反映输入框当前内容；勿回退已发送暂存，否则重绘会盖住用户新输入 */
  return n && n.kind === "agent_task" ? n.task || "" : (n && n.prompt) || "";
}
/* 本次运行用的任务文本：发送后 task 已空，取 agentTaskSent */
function procPromptForRun(n) {
  if (n && n.kind === "agent_task") {
    const sent = S.agentTaskSent && S.agentTaskSent[n.id];
    if (sent) return sent;
  }
  return procPromptOf(n);
}
function setProcPrompt(n, v) {
  if (n && n.kind === "agent_task") n.task = v;
  else if (n) n.prompt = v;
}
function clearAgentTaskSent(n) {
  if (n && S.agentTaskSent) delete S.agentTaskSent[n.id];
}

/* 节点工作目录(智能任务用 workspace,文本处理用 agentWorkspace) */
function dshWsOf(n) {
  return n && n.kind === "agent_task" ? n.workspace || "" : (n && n.agentWorkspace) || "";
}
function setDshWs(n, v) {
  if (n && n.kind === "agent_task") n.workspace = v;
  else if (n) n.agentWorkspace = v;
}

/* 目录选择器：弹出系统文件夹窗口，回填输入框 */
async function pickFolder(inp, onChange) {
  const r = await window.api.fileOpenDialog({ title: I18n.t("选择工作目录"), directory: true });
  if (!r || !r.path) return;
  inp.value = r.path;
  if (onChange) onChange(r.path);
}

/* 在资源管理器中打开工作目录（空则回落到应用默认目录） */
async function openWorkspaceFolder(dir) {
  const p =
    String(dir || "").trim() ||
    String(S.dshWorkspaceFallback || "").trim();
  if (!p) {
    toast(I18n.t("尚未设置工作目录"), "warn");
    return;
  }
  try {
    if (!window.api || !window.api.shellOpenPath) {
      toast(I18n.t("无法打开文件夹"), "warn");
      return;
    }
    const r = await window.api.shellOpenPath(p);
    if (r && r.ok === false)
      toast(I18n.t("无法打开文件夹：") + (r.error || ""), "warn");
  } catch (e) {
    toast(I18n.t("无法打开文件夹：") + ((e && e.message) || e), "warn");
  }
}

function workspaceOpenButton(getPath) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini btn-sq ws-open";
  b.textContent = "📂";
  b.title = I18n.t("在资源管理器中打开该文件夹");
  b.addEventListener("mousedown", (ev) => ev.stopPropagation());
  b.onclick = (ev) => {
    ev.stopPropagation();
    const p = typeof getPath === "function" ? getPath() : getPath;
    openWorkspaceFolder(p);
  };
  return b;
}

/* 设置项目目的地文件夹：文件夹 + 定位针图标 */
const WS_BROWSE_ICON_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2.4 4.3h3.4l1.1 1.15h6.7c.44 0 .8.36.8.8v5.55c0 .44-.36.8-.8.8H2.4a.8.8 0 0 1-.8-.8V5.1c0-.44.36-.8.8-.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>' +
  '<path d="M8.1 7.05c1.05 0 1.9.82 1.9 1.82 0 1.35-1.9 3.05-1.9 3.05S6.2 10.22 6.2 8.87c0-1 .85-1.82 1.9-1.82z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>' +
  '<circle cx="8.1" cy="8.85" r=".55" fill="currentColor"/>' +
  "</svg>";

function fillWorkspaceBrowseIcon(btn) {
  if (!btn) return;
  btn.innerHTML = WS_BROWSE_ICON_SVG;
  btn.setAttribute("aria-label", I18n.t("设置项目目的地文件夹"));
  btn.title = I18n.t("设置项目目的地文件夹");
}

/* 弹出系统文件夹窗口，回填输入框（设置项目目的地） */
function workspaceBrowseButton(inp, onPicked) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini btn-sq ws-browse";
  fillWorkspaceBrowseIcon(b);
  b.addEventListener("mousedown", (ev) => ev.stopPropagation());
  b.onclick = (ev) => {
    ev.stopPropagation();
    pickFolder(inp, onPicked);
  };
  return b;
}



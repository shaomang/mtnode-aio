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
  /* 折叠态双击进入子画布（数据库形态）：控制台内嵌大量交互控件，
     故只绑顶部 meta 标题行这类非交互区，并显式跳过 input/textarea/select/button/.port，
     避免与文本选词、按钮点击冲突。复用超级节点折叠卡同一个 enterSuper（本节点即 kind==="super"），
     不造第二套 focus 逻辑。 */
  meta.addEventListener("dblclick", (ev) => {
    if (ev.target && ev.target.closest) {
      if (
        ev.target.closest("input") ||
        ev.target.closest("textarea") ||
        ev.target.closest("select") ||
        ev.target.closest("button") ||
        ev.target.closest(".port")
      )
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    enterSuper(node);
  });
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
/* 图像识图：返回内容说明（失败则回退为占位）
   注：这三处内部抽取跑（识图 / 建表列结构 / 行抽取）写死 standard 是**刻意选择**，
   不是界面默认档的兜底（默认档真源见 app.js 的 AGENT_PRESET_DEFAULT，现已是 minimal）：
   它们要的是可被 JSON 解析器直接吞下的规整输出，与用户在界面上选哪档无关。 */
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
  /* 与 resolveDbBangRefs 同一套切词：库标题带空格也不会只读到前半截 */
  for (const h of atMentionsOf(p, supers.map((s) => s.title), { bang: true })) {
    const tok = (h.name || h.token).trim();
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

/* 把 prompt 里的 !@标题 数据库引用替换为可读指针（避免被 @ 正则吃掉），并顺手收集引用库
   切词与 @ 引用同源（atMentionsOf 的 bang 口径）：库标题本身可以含空格。 */
function resolveDbBangRefs(prompt, node) {
  const p = String(prompt || "");
  if (!p.includes("!@")) return { prompt: p, dbs: [] };
  const supers = compiledDbSupers(S.wf);
  const dbs = [];
  const out = eachAtMention(
    p,
    supers.map((s) => s.title),
    null,
    (h) => {
      const t = (h.name || h.token).trim();
      if (!t) return null;
      const db =
        supers.find((s) => s.title === t) ||
        supers.find((s) => (s.title || "").startsWith(t));
      if (db) {
        if (!dbs.some((x) => x.id === db.id)) dbs.push(db);
        return I18n.t("【数据库：{t}】", { t: db.title });
      }
      return I18n.t("【数据库：{t}】", { t });
    },
    { bang: true },
  );
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
/* ---------- Agent 语言口味：界面语言 = agent 的交流与回答语言 ----------
   文案真源在 renderer/i18n.js 的 agentLangTaste()，这里只做兜底封装；
   所有 agent 运行（会话 / 智能节点 / 助手 / 计划子任务 / 开发节点建议·问询·开发）
   都经 dshRunTask 的 systemPrompt 统一带上这一段。 */
function agentLangTasteNote() {
  try {
    return typeof I18n !== "undefined" && typeof I18n.agentLangTaste === "function"
      ? I18n.agentLangTaste()
      : "";
  } catch (_) {
    return "";
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
    /* 6/7/8 条原文（各动作返回结构、write 的 records 字段、delete 的 ids）与
       mtnode_db 工具说明是同一份机制抄两遍 —— 每步都在重发。机制只留在工具描述里，
       这里只补一句指向它，外加「写前先查」这条行为纪律。 */
    I18n.t(
      "6. 各动作与记录字段的口径以 mtnode_db 工具说明为准（list / get / query / write / delete / calc）；写 / 删之前先 query 确认，避免重复记录。",
    ),
  ].join("\n");
}

/* ── 按步切段的运行轨迹（思考 / 正文 / 工具 / 错误 各归各位）──────────────
   一次 run 一条轨迹，挂在 S.runTrace[runKey]。runKey 与取消句柄同键：
   节点 = node.id、会话 = agent:<id>、全局助手 = assist。
   段模型 items: [{ k:'think'|'say'|'tool'|'err', text, step, callId }]
     · reasoning → think 段：同一步内连续追加，跨 turn/step 或工具调用后另起一段
     · text      → say 段 ：收到 say-end（正文块收尾）或 turn/step 边界即封口
     · tool      → 只挂 callId，不再往思考文本里混「🔧 工具名」
     · error     → err 段
   切段依据是网关新字段 turn/step 与 say-end 事件；老网关不给这些字段时统一按
   step 0 归段，退化成「一段 think + 一段 say」的旧语义，渲染层无需分版本兼容。 */
function traceRunKey(runKey) {
  return String(runKey || "default");
}
function traceNum(v, fallback) {
  const n =
    typeof v === "string" && v.trim() !== ""
      ? Number(v)
      : typeof v === "number"
        ? v
        : NaN;
  return Number.isFinite(n) ? n : fallback;
}
/* 新开一轮：该 runKey 的轨迹从零开始（同名 runKey 串行复用，不残留上一轮） */
function traceReset(runKey) {
  S.runTrace = S.runTrace || {};
  const tr = {
    items: [],
    turn: 0,
    step: 0,
    /* 当前开放段所属的 `${turn}:${step}` 与两类可续写的段标记 */
    _seg: "0:0",
    _openThink: false,
    _openSay: false,
    _calls: Object.create(null),
  };
  S.runTrace[traceRunKey(runKey)] = tr;
  return tr;
}
function traceOf(runKey) {
  S.runTrace = S.runTrace || {};
  const k = traceRunKey(runKey);
  return S.runTrace[k] || traceReset(k);
}
/* 追加一条轨迹事件。kind = think | say | tool | err；say-end / turn / step 只封口不成段 */
function tracePush(runKey, kind, txt, ev) {
  if (!kind) return null;
  const tr = traceOf(runKey);
  const e = ev || {};
  if (kind === "say-end") {
    tr._openSay = false;
    return null;
  }
  if (kind === "turn" || kind === "step") {
    /* 边界事件在老网关 / session-event 透传里可能不带 turn/step 数字：
       这里只负责封口，真正的数字由随后第一个增量事件带进来 */
    if (kind === "turn") tr.turn = traceNum(e.turn, tr.turn);
    else tr.step = traceNum(e.step, tr.step);
    tr._openThink = false;
    tr._openSay = false;
    return null;
  }
  const turn = traceNum(e.turn, tr.turn);
  const step = traceNum(e.step, tr.step);
  tr.turn = turn;
  tr.step = step;
  const seg = turn + ":" + step;
  if (seg !== tr._seg) {
    tr._seg = seg;
    tr._openThink = false;
    tr._openSay = false;
  }
  const items = tr.items;
  const last = items[items.length - 1];
  const callId = e.callId == null ? "" : String(e.callId);
  if (kind === "tool") {
    if (callId && tr._calls[callId]) return null;
    if (callId) tr._calls[callId] = 1;
    const it = { k: "tool", text: "", step, callId };
    items.push(it);
    /* 一次工具调用把正在续写的段落截断：之后的思考 / 正文另起一段 */
    tr._openThink = false;
    tr._openSay = false;
    return it;
  }
  if (kind === "err") {
    const msg = String(txt || "");
    if (!msg) return null;
    if (last && last.k === "err" && last.step === step) {
      last.text += (last.text ? "\n" : "") + msg;
      return last;
    }
    const it = { k: "err", text: msg, step, callId };
    items.push(it);
    tr._openThink = false;
    tr._openSay = false;
    return it;
  }
  if (kind !== "think" && kind !== "say") return null;
  const body = String(txt || "");
  if (!body) return null;
  const flag = kind === "think" ? "_openThink" : "_openSay";
  if (tr[flag] && last && last.k === kind) {
    last.text += body;
    return last;
  }
  const it = { k: kind, text: body, step, callId: "" };
  items.push(it);
  tr[flag] = true;
  return it;
}
/* 某一类轨迹的全文（think / say / err）：段与段之间空一行，便于按步折叠展示 */
function traceText(runKey, kind) {
  const tr = S.runTrace && S.runTrace[traceRunKey(runKey)];
  if (!tr || !kind) return "";
  return tr.items
    .filter((it) => it.k === kind && it.text)
    .map((it) => it.text)
    .join("\n\n");
}
/* ── 消费侧统一口径：节点输出区 / 会话正文 / 助手侧栏都从这里取分段文本 ──
   正文（say）按段显示、段间保留空行；错误段以「⚠ 」段落附在尾部，与旧的
   _pendingAnswer 追加口径一致（stripStreamErrors 仍能整行剥掉）。
   没有轨迹时（非 dsh 运行 / 异常路径）回退到调用方给的旧缓冲，显示不退化。 */
function traceSayDisplay(runKey, fallback) {
  const body = traceText(runKey, "say");
  const errs = traceText(runKey, "err")
    .split("\n\n")
    .filter(Boolean)
    .map((s) => "⚠ " + s)
    .join("\n\n");
  const out = body && errs ? body + "\n\n" + errs : body || errs;
  return out || String(fallback || "");
}
/* 思考（think）按段文本；老缓冲里可能残留「🔧 工具名」行，抹掉后再返回 */
function traceThinkDisplay(runKey, fallback) {
  return traceText(runKey, "think") || stripToolLines(String(fallback || ""));
}
/* 兼容旧版内存缓冲：思考流曾把「🔧 工具名」混进正文，这里按行剔除 */
function stripToolLines(t) {
  const s = String(t || "");
  if (!s || s.indexOf("🔧") < 0) return s;
  return s
    .split("\n")
    .filter((l) => !/^\s*🔧/.test(l))
    .join("\n");
}
/* 分段快照：think / say / err 带正文，tool 只留 callId 与 step（工具明细在 m.tools）。
   随助手消息存档，重绘后仍能按同一步序还原「思考 · 正文 · 工具」的交替。
   总量设闸，避免超长输出把存档撑爆。 */
const TRACE_SEG_MAX_CHARS = 60000;
function traceSegmentsOf(runKey) {
  const tr = S.runTrace && S.runTrace[traceRunKey(runKey)];
  if (!tr || !Array.isArray(tr.items) || !tr.items.length) return [];
  const out = [];
  let budget = TRACE_SEG_MAX_CHARS;
  for (const it of tr.items) {
    if (it.k === "tool") {
      out.push({ k: "tool", step: it.step, callId: it.callId || "" });
      continue;
    }
    let text = String(it.text || "");
    if (!text || budget <= 0) continue;
    if (text.length > budget) {
      text = text.slice(0, budget);
      budget = 0;
    } else {
      budget -= text.length;
    }
    out.push({ k: it.k, step: it.step, text });
  }
  return out;
}

/* 段快照落盘共用：先过限长闸（app-assist.js 的 agentSegsForDisk，未加载时原样），
   再确认这些段能按时间线还原出与 content 完全一致的正文才留下，
   避免对不上号的段白占存档。调用时机：msg.content 已写好。 */
function attachTraceSegments(msg, runKey) {
  if (!msg || !runKey) return msg;
  let segs = traceSegmentsOf(runKey);
  if (segs.length < 2) return msg;
  if (typeof agentSegsForDisk === "function") segs = agentSegsForDisk(segs);
  if (!segs || segs.length < 2) return msg;
  msg.segments = segs;
  if (typeof dshMsgSegsViewable === "function" && !dshMsgSegsViewable(msg))
    delete msg.segments;
  return msg;
}
/* 网关事件 → 轨迹：在 dshRunTask 内统一喂，节点 / 会话 / 助手共用同一套切段规则 */
function traceFeedEvent(runKey, type, d) {
  const e = d || {};
  if (type === "reasoning") {
    if (e.text) tracePush(runKey, "think", e.text, e);
  } else if (type === "text") {
    if (e.text) tracePush(runKey, "say", e.text, e);
  } else if (type === "say-end") {
    tracePush(runKey, "say-end", "", e);
  } else if (type === "tool") {
    tracePush(runKey, "tool", "", e);
  } else if (type === "error") {
    if (e.message) tracePush(runKey, "err", String(e.message), e);
  } else if (type === "session-event") {
    const t = e.type;
    if (t === "turn/start" || t === "turn/end")
      tracePush(runKey, "turn", "", e.data || {});
    else if (t === "step/start" || t === "step/end")
      tracePush(runKey, "step", "", e.data || {});
  }
}

/* 运行一次 agent 任务；返回最终文本。onEvent(type, data) 观察流式事件。 */
/* ---------- 出错自动重发（宿主侧最外层重试 · 需求「429 不要跳过下一个任务」） ----------
 * 网关一次 error = 整轮失败。旧行为：会话落一条「（错误：…）」就完事，计划执行器
 * 把这一项记为 failed 并**直接接着跑下一项** —— 用户看到的是「429 一响，任务全跳过」。
 * 现在在最外面补一道闸：一次运行失败 → 等 5 秒 → **原样重发这一轮**（同 input、同 runKey、
 * 同轨迹口径；重发那一轮开头 traceReset 会把上一轮的部分正文与 ⚠ 错误行一起清掉），
 * 最多 DSH_RETRY_MAX 次。等待窗口里这一轮仍算「在跑」：计划不会往下走、用户新消息
 * 照旧进发送队列、左下角运行队列仍然挂着这条会话 —— 正是「不跳过，等一会儿重发」。
 * 绝不重发的两种情形：
 *   · 用户主动终止（错误文案是取消类 / 节点 _aborted / 等待中被 ■ 打断）；
 *   · 重发也不可能变好的配置类错误（没配 API Key、任务内容为空、工作范围受限）。
 * 引擎内部另有一层 @deepseek-ai/dsh-llm-retry（按服务商 retryPolicy，见 cordis.yml），
 * 那一层管单次模型请求；本层管「整轮消息」，两者互不替代。
 * ---------- 优先续跑（重发闸的新默认 · 「原样重发」退为兜底） ----------
 * 整轮重发的代价是前功尽弃：模型上下文从零重建，已经写出来的几千字白烧一遍 token。
 * 现在重发前先试着接着写：
 *   · dshRunOnce 捕获网关报回的本轮 dsh 会话 id（session 帧，以及 done / error 上的
 *     data.sessionId），连同这一轮的配置指纹 sig 存进 S._runSession[runKey]，
 *     本轮成功结束后清掉该键；
 *   · 失败要重发时：会话在、指纹没变、而且确实攒到了部分产出 → 下一 attempt 发
 *     dshResumeDirective 的「从中断处接着写」指令 + resumeSession，运行时沿用原上下文
 *     （见 dsh/DESIGN.md 断点续跑契约），不再重发任务原文；已累计的正文以 seedText
 *     带进 dshRunOnce，所以返回给调用方的仍是整轮完整正文；keepTrace 让失败轮的
 *     轨迹不被抹掉，归档段仍能还原「前半 + 续写后半」；
 *   · 续不上（没抓到会话 / 指纹变了 / 一个字都还没写出来）就退回上面的整轮重发；
 *   · 网关点名 RESUME_UNAVAILABLE（会话不可续跑：盘上无日志、或运行时经 session/resume
 *     握手也恢复不了 —— 宿主只认这个前缀，见 dshResumeUnavailable）时立刻用原始 input
 *     整轮重发；老网关没有握手桥、原样透传运行时 id collision（见 dshResumeCollision）
 *     时同样整轮重发，且这一次不计入 DSH_RETRY_MAX 预算 —— 它只是续不上，不是又
 *     失败了一次。（续跑三态：同进程复用 / 跨进程盘上恢复 / 整轮重发兜底，见
 *     dsh/DESIGN.md「断点续跑契约」。） */
const DSH_RETRY_DELAY_MS = 5000; /* 需求指定：等 5 秒后重新发送 */
const DSH_RETRY_MAX = 5; /* 上限：持续限流也不能无限占着这一轮 */
const DSH_RESUME_UNAVAILABLE = /^RESUME_UNAVAILABLE\b/; /* 网关固定的「不可续跑」标记 */

/* 续跑点名的会话「盘上有日志但接不上」（运行时侧 id collision）：dsh-session-persistence
   在会话/created 时发现盘上旧日志与实时会话的前缀对不上，会硬抛这几句。接入 session/resume
   桥（plugins/session-resume-server.mjs）后，续跑轮会先握手让运行时从盘上恢复（跨进程真续），
   同进程命中更是零开销 —— collision 只剩兜底路径才出现：老网关没有握手桥而回落 create
   语义（新 runtime 以「新会话 + 只有续跑指令的 seed」去碰盘上旧日志 → 冲突报错），或
   恢复被拒后仍落到 create 路径；即「文件在盘 ≠ 续得上」的最终形态。
   这类报文对宿主与 RESUME_UNAVAILABLE 同义：续不上 → 立即用原始 input 整轮重发，
   绝不拿同一个 dead id 连撞 5 次重发预算（用户只看到莫名 id collision 报错）。
   （三态与握手细节见 dsh/DESIGN.md「断点续跑契约」。） */
const DSH_RESUME_COLLISION = /\(id collision\)|persisted log on disk|does not match this live session|persisted at a different cwd|bound to a different live session/;

/* 报文是否属「运行时续不上」的 id collision 家族（网关新版本会先转译成
   RESUME_UNAVAILABLE 前缀；老网关原样透传时这里兜底识别） */
function dshResumeCollision(msg) {
  return DSH_RESUME_COLLISION.test(String(msg || ""));
}

/* 本轮配置指纹：原七项（workspace|model|provider|preset|effort|pure|maxTokens）
   + 网关 runtimeKey 的同源成分（见 dsh/gateway/gateway.mjs getRuntime →
   runtimeKey / provHash：apiKey secret、baseUrl、webSearchKey 前缀 ws:、persona
   hp:、工具集 tl:、envPatch 服务商密钥表）的稳定哈希。缺失字段一律按空串计
   （调用点只传它拿得到的值，如分节快照口径只传配置七项也合法）。
   指纹变了 = 这一次运行与那条会话不是同一套配置跑出来的，续跑会把别的配置的上下文
   灌进本轮，只能整轮重发。
   为什么必须带 runtimeKey 同源成分：网关的 runtime key 由上述全部成分拼成，任一
   成分漂移（密钥 / 端点 / 联网搜索 Key / 人设 / 工具集 / 服务商密钥表）都会让网关
   另起一台新 runtime；此时若宿主侧签名还判「一致」、点名续跑那条旧会话，即使
   session/resume 握手能把旧日志从盘上恢复为 live，恢复出来的也是**旧配置的上下文**，
   与本轮不符 —— 等价于「假装续上，实则换配置冷起」（老网关/老运行时无握手桥时则
   直接撞 id collision）。把这些成分纳入签名后，漂移即判整轮重发，从根上杜绝该场景。 */
function dshRunSigOf(p) {
  return dbHash(
    [
      p.workspace || "",
      p.model || "",
      p.provider || "",
      p.preset || "",
      p.effort || "",
      p.pure ? 1 : 0,
      /* 按运行裁剪可见工具集（精简工具负载 / 画布智能节点不给画布工具）：
         两者都改网关 runtime key 与固定前缀的 tools 段 → 漂移 = 换 runtime 冷起，
         必须进签名，否则会把「旧可见集的会话」当同配置续跑。 */
      p.lean ? 1 : 0,
      p.noCanvas ? 1 : 0,
      /* hideTools 名单通道：网关把规范后的名单打进 runtime key 的 hx: 指纹 */
      p.hide || "",
      p.maxTokens == null ? "" : p.maxTokens,
      /* ── runtimeKey 同源成分（对齐网关 getRuntime 的指纹输入）── */
      p.apiKey || "", /* runtimeKey 的 apiKey secret（sha1 前 12 hex 的原文输入） */
      p.baseUrl || "", /* runtimeKey 的 baseUrl */
      p.webSearchKey || "", /* provHash 的 ws:（联网搜索 Key，取原文） */
      p.persona || "", /* provHash 的 hp:（hostPersona 哈希的原文输入） */
      p.tools || "", /* provHash 的 tl:（工具描述子 JSON，取原文） */
      p.envPatch || "", /* provHash 的 envPatch（服务商密钥表 JSON，取原文） */
    ].join("|"),
  );
}

/* 设置里的「精简工具负载」开关（默认关 → 行为与此前逐字一致）。唯一读点在
   dshRunOnce 拼 runParams.lean 处。开了它，运行时干脆不注册 mtnode_app /
   mtnode_vision（两者合计 ~4.9K 字符，每一步都随固定前缀重发一遍）。 */
function dshLeanToolsOn() {
  return !!(S.config && S.config.dsh && S.config.dsh.leanToolPayload);
}

/* lean / noCanvas 两个整档闸各自裁掉的名字（与 dsh/gateway/canvas-plugin.mjs 里的
   LEAN_DROP_WHEN_LEAN / NODE_LOCK_DROP_CANVAS 同值 —— 那边是真源，改那边记得改这里）。
   宿主侧列这份只为「别把已经被整档闸裁掉的名字再重复写进 hideTools 名单」：重复不致错
   （注册口取并集），但会让网关那句「本轮不注册的工具」与「精简工具负载」说两遍。 */
const DSH_TOOLS_DROPPED_BY_LEAN = ["mtnode_app", "mtnode_vision"];
const DSH_TOOLS_DROPPED_BY_NO_CANVAS = [
  "mtnode_canvas_get",
  "mtnode_canvas_edit",
  "mtnode_app",
];
/* 开发绑定会话（Gate A）只裁「读图」这一半：mtnode_canvas_get 的整张快照与 mtnode_app
   的画布目录对它没有信息量（改代码读的是项目根真实文件），而 mtnode_canvas_edit 必须留着
   —— 收尾要按契约回写本节点的 note / devStatus / devFiles。合计约 10.0K 字符/步不再重发。 */
const DSH_TOOLS_DROPPED_BY_NO_READ = ["mtnode_canvas_get", "mtnode_app"];

/* 按运行要隐藏的工具名（第三个闸：随 run 参数 hideTools 下发网关 → runtime key 的
   hx: 指纹 + spawn env MTNODE_HIDE_TOOLS → 注册口不注册 / mtnode-tool-visibility 插件
   在 agent 作用域 ctx.tools.restrict({deny}) 摘除）。判据主要来自「这一轮宿主会不会
   直接拒绝这个调用」，另加一条纯省 token 的（第三个点）：
   · Agent 工具许可预设里被拒到点上的类别（映射真源 app-nodes.js agentDeniedToolNames）；
   · 本轮没接入任何数据库副本 → mtnode_db（未接入时宿主一律回「当前任务未接入数据库」）；
   · 开发绑定会话（noCanvasRead）→ 读画布两件套：宿主允许它读图，但开发改的是项目根
     里的真实文件，整张画布快照对这个会话没有信息量（收尾只回写自己那一个节点）。
   输出排序去重：同一档每轮逐字相同，runtime key 才稳定，同档会话共享一台运行时、
   每一步前缀一致 —— 轮内改可见集是从第一个变化的 schema 起整段缓存失效，赔得更多。 */
function dshHiddenToolsFor(o) {
  if (!o || o.pure) return [];
  let names = [];
  try {
    names =
      typeof agentDeniedToolNames === "function" ? agentDeniedToolNames() : [];
  } catch (_) {
    names = [];
  }
  names = Array.from(names || []);
  if (!o.dbGrounded) names.push("mtnode_db");
  /* 开发绑定会话（noCanvasRead）：读画布两件套点名进名单。走的是「按名字」这条通道
     （不是 MTNODE_NO_CANVAS 整档闸），因为那闸连 mtnode_canvas_edit 一起裁 —— 收尾回写
     就没了。若 lean / noCanvas 已经把这些名字裁掉，下面 covered 判据让它不重复出现。 */
  if (o.noCanvasRead) for (const n of DSH_TOOLS_DROPPED_BY_NO_READ) names.push(n);
  const covered = {};
  if (o.lean) for (const n of DSH_TOOLS_DROPPED_BY_LEAN) covered[n] = 1;
  if (o.noCanvas) for (const n of DSH_TOOLS_DROPPED_BY_NO_CANVAS) covered[n] = 1;
  const seen = {};
  const out = [];
  for (const n of names) {
    const s = String(n || "").trim();
    if (!s || seen[s] || covered[s]) continue;
    seen[s] = 1;
    out.push(s);
  }
  return out.sort();
}

/* 续跑指令：只说「从中断处接着写」，绝不带任务原文 —— 原文已经在那份 session 的
   上下文里，再塞一遍等于让模型从头重写（文案经 I18n.t，跟随界面语言）。 */
function dshResumeDirective(errMsg) {
  const s = String(errMsg || "")
    .replace(/\s+/g, " ")
    .trim();
  const brief = s.length > 160 ? s.slice(0, 160) + "…" : s;
  return (
    I18n.t("【续跑】上一轮回答在中途报错：") +
    (brief || I18n.t("（无错误信息）")) +
    "\n" +
    I18n.t(
      "请在原有上下文的基础上，从刚才中断的地方继续把任务做完：直接往下输出剩余内容，" +
        "不要重复已经写出的部分，也不要重新从头开始或再次复述任务。",
    )
  );
}

/* 网关说「这个会话在本机不可续跑」？（会话文件被清理 / id 不属于这台机器） */
function dshResumeUnavailable(msg) {
  return DSH_RESUME_UNAVAILABLE.test(String(msg || ""));
}

/* 可续跑的会话登记：这一轮登记过 session id，且它的配置指纹与刚失败的这一轮一致
   （不是别的轮次留在表里的旧条目）。不满足返回 null → 退回整轮重发。
   指纹口径 = dshRunSigOf 全量成分（含网关 runtimeKey 同源成分）：apiKey / baseUrl /
   webSearchKey / persona / tools / envPatch 任一漂移都会让网关另起 runtime —— 即便
   session/resume 握手把旧会话恢复为 live，恢复出的也是旧配置的上下文，必须在此判
   null、整轮重发。 */
function dshResumableSession(runKey) {
  const sess = S._runSession && S._runSession[runKey];
  if (!sess || !sess.sid) return null;
  const cur = S._runSig && S._runSig[runKey];
  if (!cur || sess.sig !== cur) return null;
  return sess;
}

/* 重发判据：取消 / 终止类与配置类不重发，其余（429 / RATE_LIMIT / 5xx / 网络 / 引擎掉线）都重发 */
function dshRunRetryable(msg) {
  const s = String(msg || "");
  if (!s.trim()) return false;
  if (typeof isCancelishError === "function" && isCancelishError(s)) return false;
  /* 「已手动终止」「运行长时间无响应，已自动终止」这类宿主自己收尾的报文：
     词表里的整词（已终止 / 已请求终止）都不含它们 —— 旧判据把它们当「引擎掉线」
     重烧 5 轮，用户明明按了停止。终止 / 中止 一律判死（只在本闸内收，
     不去动那个被界面多处复用的显示判据 isCancelishError）。 */
  if (/终止|中止/.test(s)) return false;
  if (
    /* 范围被拒（助手「仅当前画布」/ 会话所属画布）与所属画布已删都是「重发也不会有别的
       结果」：判据串与 app-nodes.js 的 scopeBlocked、app.js 的 sessionWfDeletedError 同源。
       「工作范围为「当前画布」」一条留给工作区那层的范围受限文案。 */
    /未配置|API Key|任务内容为空|工作范围为「当前画布」|工作范围是「仅当前画布」|无法访问其他画布|无法读取或操作其他画布|本会话所属画布已被删除|智能能力未启用/.test(
      s,
    )
  )
    return false;
  return true;
}

/* 与 dshRunOnce 同一口径算出取消句柄键（会话 agent:<id> / 节点 node.id / 助手 assist） */
function dshRunKeyOf(opts) {
  return String(opts.runKey || (opts.node && opts.node.id) || "default");
}

/* ── 终止戳：这一轮是不是被「判死」了（重发闸唯一的判据） ──
   写入方 = 所有终止入口共用的 dshCancelActive（app.js / app-agent.js 两份同名实现，
   会话 ■ / 节点 ■ / 全部终止 / 运行队列行 / 提问卡「稍后·中断」/ 看门狗静默超时都走它）；
   消费方 = 下面 dshRunTask 的重发闸。
   为什么必须有一枚戳、不能只看报错文案：用户按停止 → 网关关掉这一轮的运行时进程 →
   回给宿主的多半是工程报文（"Harness runtime closed" / "runtime is not running" /
   "transport closed" / 进程退出码），一个「取消 / 终止」字样都没有 —— 旧判据把它们
   当「引擎掉线」，于是「按了停止反而进入 5 秒 × 5 次重发」，钱照烧、界面照动。
   记的是**单调递增代号**而不是时间戳：不依赖时钟粒度；比较口径 = 「本轮起跑之后代号
   有没有变过」，所以「先停止、再发新消息」的下一轮不会被上一轮的停止误判死。
   不带 runKey 的「全部终止」盖全局 '*'：连还没占上取消句柄（正在异步起 runtime）的
   在途轮也一并判死。静默超时的自动终止同样判死 —— 30 分钟无响应再重烧 5 轮
   （每轮上限又是 30 分钟）不叫恢复，叫拖死界面。 */
function dshStopMark(runKey) {
  if (typeof S === "undefined" || !S) return 0;
  S._runStop = S._runStop || {};
  const seq = (Number(S._runStopSeq) || 0) + 1;
  S._runStopSeq = seq;
  const k = String(runKey == null ? "" : runKey).trim();
  S._runStop[k || "*"] = seq;
  return seq;
}
/* 这一轮当前的终止代号：自身键与全局 '*' 取大（'*' = 有人喊过「全部终止」） */
function dshStopSeqOf(runKey) {
  const m = (S && S._runStop) || {};
  const a = Number(m[runKey]) || 0;
  const b = Number(m["*"]) || 0;
  return a > b ? a : b;
}
/* 本轮起跑（base = 起跑时读到的代号）之后是否被判过死 */
function dshStopStamped(runKey, base) {
  return dshStopSeqOf(runKey) > (Number(base) || 0);
}

/* 续跑不可用的原因（消费方据此给 toast 措辞；返回 null = 本轮可续跑）：
   · 'no-session' —— 本轮还没登记到网关报回的 session id（很早期就挂了 / 宿主没接入续跑）；
   · 'sig-drift'  —— 会话在，但配置指纹变了：不是同一套配置跑出来的。指纹含网关
      runtimeKey 同源成分（apiKey / baseUrl / webSearchKey / persona / tools /
      envPatch），这些漂移 = 网关会另起新 runtime —— 即便握手把旧会话恢复为 live，
      恢复出的也是旧配置的上下文，只能整轮重发（杜绝「假装续上，实则换配置冷起」）；
   · 'no-output'  —— 会话与配置都吻合，但一个字都还没写出来（续跑没有意义）。 */
function dshResumeBlockReason(runKey, carriedChars) {
  const sess = dshResumableSession(runKey);
  if (!sess) {
    const had = S._runSession && S._runSession[runKey];
    const cur = S._runSig && S._runSig[runKey];
    if (had && cur && had.sig !== cur) return "sig-drift";
    return "no-session";
  }
  return carriedChars > 0 ? null : "no-output";
}

/* 这一次重发算「续写」还是「整轮重发」（消费方据此决定清不清失败轮的残文）：
   · resumed=true  —— 重发点名沿用失败轮那条 dsh 会话（resumeSession），新内容接在
     **同一条逻辑轮次**后面：已显示的部分正文 / 工具列表 / 思考槽一律保留；
   · resumed=false —— 整轮重发（新铸会话、上文全丢）：照旧清空重画，否则同一轮
     内容会叠两遍。
   判据与重发闸同源：本轮已在续跑通道上（opts.resumeSession）、或该 runKey 登记过
   可续跑的会话（配置指纹一致，见 dshResumableSession）都算续写；网关已判
   RESUME_UNAVAILABLE（会话不可续跑：盘上无日志、或运行时握手也恢复不了）时一律
   false，退回整轮重发。
   指纹口径含网关 runtimeKey 同源成分：apiKey / baseUrl / webSearchKey / persona /
   tools / envPatch 任一漂移时 dshResumableSession 已判 null → resumed=false
   （整轮重发），绝不在配置已变时点名续跑旧会话 —— 哪怕握手能把旧会话恢复为 live，
   恢复出的也是旧配置的上下文。
   宿主完全没接入续跑（没有会话登记）时也恒为 false，与接入前行为一字不差。 */
function dshRetryResumed(opts, msg, runKey) {
  if (dshResumeUnavailable(msg) || dshResumeCollision(msg)) return false;
  if (opts && opts.resumeSession) return true;
  return typeof dshResumableSession === "function" &&
    !!dshResumableSession(runKey);
}

/* 重发等待窗口：先占一个「本轮仍在途」的取消句柄，用户此刻按 ■ 也能立刻打断
   （dshCancelActive 删掉句柄 = 用户不要这一轮了 → 不再重发）。
   句柄已被别的新一轮接管时同样不重发，绝不与新一轮抢同一个 runKey。
   等待不是「睡满 N 秒再醒」：旧实现只在 setTimeout 到点时看一眼，用户按了停止也要
   把剩下的秒数等完（停止最慢 5 秒才生效）。现在每 ~100ms 醒一次，句柄一没就立刻收尾。 */
function dshRetryWait(runKey, delayMs) {
  S._runCancels = S._runCancels || {};
  if (S._runCancels[runKey]) return Promise.resolve(false);
  const ticket = { cancelTag: runKey, workspace: "", _retryWait: true };
  S._runCancels[runKey] = ticket;
  const total = Math.max(0, Number(delayMs) || 0);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const cur = S._runCancels && S._runCancels[runKey];
      /* 句柄被删（用户按 ■ / 看门狗判死）或被新一轮接管 → 这一轮不再重发 */
      if (cur !== ticket) {
        resolve(false);
        return;
      }
      const left = total - (Date.now() - startedAt);
      if (left <= 0) {
        delete S._runCancels[runKey];
        resolve(true);
        return;
      }
      setTimeout(tick, Math.min(100, left));
    };
    tick();
  });
}

/* 一次智能运行的唯一入口：失败自动等 5 秒重发（见上），真正发请求的是 dshRunOnce。
   重发的新默认是「优先续跑」：拿得到本轮会话就发续跑指令接着写，续不上才整轮重发。 */
function dshRunTask(input, opts) {
  opts = opts || {};
  const runKey = dshRunKeyOf(opts);
  /* 起跑时读到的终止代号：重发闸拿它比对，判「这一轮是不是在跑的中途被 ■ 停掉了」。
     真源 = dshStopMark（所有终止入口共用的 dshCancelActive 负责盖）。 */
  const stopBase = dshStopSeqOf(runKey);
  let tries = 0;
  /* 已累计正文：包一层 onEvent 把各轮的 text 增量攒下来 —— 续跑那一轮拿它当
     seedText，所以 dshRunOnce 返回的仍是「前半 + 续写后半」的整轮完整正文 */
  let carried = "";
  const userOnEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
  const baseOpts = Object.assign({}, opts, {
    onEvent: (type, data) => {
      if (type === "text" && data && data.text) carried += String(data.text);
      if (userOnEvent) {
        try {
          userOnEvent(type, data);
        } catch (_) {}
      }
    },
  });
  const notifyRetry = (probeOpts, msg, delayMs, carriedChars) => {
    /* 通知调用方本轮重发的口径（resumed 见 dshRetryResumed）：
       · resumed=true  → 续写，保留已显示的部分正文 / 工具列表 / 思考槽；
       · resumed=false → 整轮重发，清掉上一轮残文（否则重发后内容会叠两遍）
       carriedChars = 这一次重发还替调用方守着多少已写正文（整轮重发记 0） */
    try {
      if (typeof opts.onEvent === "function")
        opts.onEvent("retry", {
          attempt: tries,
          max: DSH_RETRY_MAX,
          delayMs,
          message: msg,
          resumed: dshRetryResumed(probeOpts, msg, runKey),
          carriedChars: carriedChars || 0,
        });
    } catch (_) {}
  };
  /* resume = {sid, err}：沿用的会话 id + 刚失败的报错（写进续跑指令）；null = 整轮重发 */
  const attempt = (resume) => {
    const sid = resume && resume.sid ? String(resume.sid) : "";
    /* 整轮重发从零累计（新会话会把全文重写一遍）；续跑轮沿用已累计的半截正文 */
    if (!sid) carried = "";
    const nextOpts = sid
      ? Object.assign({}, baseOpts, {
          resumeSession: sid,
          /* 同一个会话的 system 已经落在那份 session 里：再下发只会污染上下文
             （宿主人设一节因此为空；dshRunOnce 识别这一轮走 full 旁路并作废分节快照） */
          systemPrompt: "",
          seedText: carried,
          keepTrace: true,
        })
      : baseOpts;
    return dshRunOnce(
      sid ? dshResumeDirective(resume.err) : input,
      nextOpts,
    ).catch(async (err) => {
      const msg = (err && err.message) || String(err || "");
      const node = opts.node;
      if (node && node._aborted) throw err;
      /* 本轮已被判死（有人调了 dshCancelActive：■ 停止 / 全部终止 / 中断任务 /
         看门狗静默超时）→ 立即收口，一次都不重发，也不走下面「不可续跑 → 整轮重发」
         那条快速通道。需求口径：「停止模型或会话时，应当立即停止，而不是进入 5 次重试」。
         终止时刻与本轮重叠时（如 429 之后已进入 5 秒窗口）多半就是这条路径 ——
         网关把运行时关掉后回来的工程报文（"Harness runtime closed" 等）不含取消字样，
         只有这枚戳认得它。保留原始报错当收尾文案更有信息量，但它必须先是取消类文案。 */
      if (dshStopStamped(runKey, stopBase))
        throw isCancelishError(msg) || /终止|中止/.test(msg)
          ? err
          : new Error(I18n.t("已手动终止"));
      /* 续跑点名的会话在本机不可续跑：立刻用原始 input 整轮重发，不消耗 5 次
         重发预算 —— 它只是续不上，不是又失败了一次（见上方续跑闸注释）。
         识别口径两类：网关固定的 RESUME_UNAVAILABLE 前缀（盘上无日志 / 运行时握手
         也恢复不了），以及运行时侧 id collision 家族（老网关没有握手桥而回落 create
         语义撞盘上旧日志、原样透传时在这里兜底；新网关会先转译成
         RESUME_UNAVAILABLE 前缀）。 */
      if (sid && (dshResumeUnavailable(msg) || dshResumeCollision(msg))) {
        notifyRetry(baseOpts, msg, 0, 0);
        try {
          toast(
            I18n.t("该会话已不可续跑，立即用原任务整轮重发（不计入重发次数）"),
            "warn",
          );
        } catch (_) {}
        carried = "";
        const go = await dshRetryWait(runKey, 0);
        if (!go) throw new Error(I18n.t("已手动终止"));
        return attempt(null);
      }
      if (tries >= DSH_RETRY_MAX || !dshRunRetryable(msg)) throw err;
      tries++;
      const brief = msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
      /* 优先续跑的三条件：本轮登记过会话且配置指纹没变（dshResumableSession，
         指纹含网关 runtimeKey 同源成分：apiKey / baseUrl / webSearchKey / persona /
         tools / envPatch —— 这些漂移 = 网关另起 runtime 冷起伪续跑，
         必须退回整轮重发）+ 确实攒到了部分产出（carried）；缺一就退回整轮重发。
         resumeBlocked 区分「为什么续不上」，配置漂移时给用户明确 toast。 */
      const sess = dshResumableSession(runKey);
      const next = sess && carried.length > 0 ? { sid: sess.sid, err: msg } : null;
      const resumeBlocked = dshResumeBlockReason(runKey, carried.length);
      const chars = next ? carried.length : 0;
      notifyRetry(next ? { resumeSession: next.sid } : baseOpts, msg, DSH_RETRY_DELAY_MS, chars);
      try {
        toast(
          I18n.t("本轮出错，") +
            Math.round(DSH_RETRY_DELAY_MS / 1000) +
            (next
              ? I18n.t(" 秒后从中断处继续（第 ")
              : I18n.t(" 秒后整轮重发（第 ")) +
            tries +
            "/" +
            DSH_RETRY_MAX +
            I18n.t(
              next
                ? " 次）· 已写内容不重烧 · "
                : resumeBlocked === "sig-drift"
                  ? " 次）· 运行配置已变化，无法从中断处续跑 · "
                  : " 次）· 不跳到下一个任务 · ",
            ) +
            brief,
          "warn",
        );
      } catch (_) {}
      const go = await dshRetryWait(runKey, DSH_RETRY_DELAY_MS);
      if (!go) throw new Error(I18n.t("已手动终止"));
      return attempt(next);
    });
  };
  return attempt(null).catch((err) => {
    /* 彻底放弃这一轮：它登记的可续跑会话到此作废，别留给下一次运行 */
    if (S._runSession) delete S._runSession[runKey];
    throw err;
  });
}

/* ── 本轮运行的「绑定画布」：会话所属画布，不是用户此刻看到的画布 ──
   过去这里每轮现取 S.wf：用户在会话跑着的时候切去别的画布干活，会话的画布读写、
   工作区、数据库接地就整轮漂到那张图上（本轮改动全落错地方）。现在归属真源只有一个：
   会话创建时绑下的 canvasWfId（app-assist.js），按 id 解析回画布对象见 app.js
   wfOfCanvasIdForRun（前台 → 内存袋 → 读盘，画布已删直接抛明确错，绝不漂）。
   解析不到归属的三类运行照旧跟着用户看到的画布：全局助手（范围另由 applyAssistScope
   决定）、裸节点运行（节点本就活在前台画布上）、以及没有 canvasWfId 的老会话 ——
   后者在本轮就地补绑一次并落盘，从下一轮起它就是稳定真源。 */
async function dshResolveRunBoundWf(opts) {
  const sess =
    typeof agentSessionOfRun === "function" ? agentSessionOfRun(opts) : null;
  const id = String((opts && opts.canvasWfId) || (sess && sess.canvasWfId) || "").trim();
  const cur =
    (typeof currentVisibleWf === "function" ? currentVisibleWf() : null) || S.wf || null;
  if (!id) {
    if (sess && cur && cur.id) {
      try {
        sess.canvasWfId = String(cur.id);
        if (typeof persistAgentSession === "function")
          Promise.resolve(persistAgentSession()).catch(() => {});
      } catch (_) {}
    }
    return cur;
  }
  if (typeof wfOfCanvasIdForRun !== "function") return cur;
  return await wfOfCanvasIdForRun(id);
}

/* 单次运行（一次请求 = 一轮）：组装 runParams、挂取消句柄、收流式事件 */
function dshRunOnce(input, opts) {
  opts = opts || {};
  /* 终止代号基线：装配这一段是异步的（工作目录探测 / 分节快照 / 工具快照都要读盘），
     期间用户完全可能已经按了 ■ —— 那一刻取消句柄还没登记，dshCancelActive 抓不到这一轮
     （网关侧另有 wantCancelTag 兜「已发到网关」的早到取消，宿主这段空白只能自己判）。
     所以到真要发请求之前用终止戳补判一次：被判死就一个 token 都不烧。 */
  const stopBase = dshStopSeqOf(dshRunKeyOf(opts));
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
  /* 本轮绑定画布（= 会话「所属画布」）：解析可能要读盘，故在第一个 then 里定下来，
     之后工作区、工具快照、数据库接地、画布事件路由全用它，绝不再现取 S.wf。 */
  let boundWf = null;
  /* 工作区按绑定画布解析（优先级一字不改：手填 > 该画布项目根 > 该画布目录 > 默认目录） */
  const wsOfRun = (node) =>
    typeof dshWorkspaceOfWf === "function"
      ? dshWorkspaceOfWf(node, boundWf)
      : dshWorkspaceOf(node);
  return Promise.resolve()
    .then(async () => {
      boundWf = await dshResolveRunBoundWf(opts);
      let ws = String(opts.workspace || wsOfRun(opts.node) || "").trim();
      if (ws && typeof pathIsExistingDir === "function") {
        if (!(await pathIsExistingDir(ws))) {
          await wipeMatchingWorkspaces(ws);
          ws = String(wsOfRun(opts.node) || "").trim();
          if (ws && !(await pathIsExistingDir(ws))) ws = "";
          toast(I18n.t("工作目录无效，已改用默认目录"), "warn");
        }
      }
      return ws || S.dshWorkspaceFallback || "";
    })
    .then(async (workspace) => {
  /* 本轮绑定画布 = 会话「所属画布」（上一个 then 里按 canvasWfId 解析，可能要读盘）；
     解析不到对象才退回用户此刻看到的画布。此后工作区、工具快照、数据库接地、
     beginCanvasRun 与画布事件路由全用这一个对象 —— 用户中途切画布，本轮不漂。 */
  if (!boundWf) boundWf = currentVisibleWf() || S.wf;
  const nodeLock = isCanvasScopedAgentNode(opts.node);
  /* 纯净模式（会话输入区「纯净模式」按钮）：整段 system prompt 置空，
     不含技能索引 / 数据库接地 / 工具策略 / 语言口味 —— 模型输入 = 纯粹的用户输入。
     网关侧 preset 强制走空文本档（pure），引擎人设由 MTNODE_PURE 标记移除。 */
  const pureOn = !!opts.pure;
  /* 按运行裁剪可见工具集（下发网关 → spawn env → canvas-plugin 的 register()）：
     · leanOn = 设置「精简工具负载」：整个不注册 mtnode_app / mtnode_vision；
     · noCanvasOn = 画布智能节点（nodeLock）**或**用户声明「与画布无关」（opts.noCanvas）：
       宿主对 get / edit / app 帧一律用不上，那约 25,993 字符的画布工具定义干脆不发
       （每步约省 7K token），mtnode_vision 仍保留（智能节点人设明确允许它识图）。
       第二条来源：会话输入区「与画布无关」chip 与助手栏同名开关（Gate B），
       由调用方经 opts.noCanvas 传进来（app-assist.js agentSessionSend / assistSend）。
     两者都改 runtime key 与固定前缀形状 → 一并进 runSig（见 dshRunSigOf）。 */
  const leanOn = dshLeanToolsOn() && !pureOn;
  /* 用户声明档（与 nodeLock 区分开：nodeLock 的人设与技能索引口径本轮照旧不改） */
  const canvasFreeOn = !!opts.noCanvas && !pureOn;
  const noCanvasOn = (nodeLock || canvasFreeOn) && !pureOn;
  /* 读图裁剪（只点名「读画布」两件套，不裁改图）：开发绑定会话由宿主打标 noCanvasRead（真源
     app.js createDevSessionForNode：mode === "dev" 时置位、随会话落盘），经
     agentSessionSend → dshRunTask 的 baseOpts 原样透到这里。它不动上面两个整档标记，
     只往 hideTools 名单里点名 mtnode_canvas_get / mtnode_app（约 10.0K 字符/步），
     mtnode_canvas_edit 留着 —— 收尾要按契约回写本节点的 note / devStatus / devFiles。
     可见集变化已经由 hideTools 进 runSig 的 hide: 与网关 hx: 指纹，不必另加签名成分。
     整档闸已生效时（canvasFreeOn）这一位无需再点名：三件套本来就不注册。 */
  const noReadOn = !!opts.noCanvasRead && !pureOn && !canvasFreeOn;
  /* 技能索引档位：无读画布的那几轮（Gate A 开发绑定会话、Gate B 用户声明「与画布无关」）
     不下发画布类技能条目 —— 条目指向的操作规范本轮执行不了，留着只是白占前缀 + 诱导模型
     去调不存在的工具。档位名真源 = app-agent.js MTNODE_SKILL_INDEX_TRIM（这里写字面量，
     免得测试沙箱缺这个跨文件常量）。nodeLock（画布智能节点）本轮不改（它的人设另有出处，
     行为照旧）。 */
  const indexBlock = await mtnodeInternalSkillIndexBlock(
    noReadOn || canvasFreeOn ? "noCanvas" : "",
  );
  /* 数据库接地注记：非空 = 本轮真接入了数据库副本（连线进来的副本 + prompt 里的
     !@数据库标题）。先算出来，两处共用同一判据 —— 注记与 mtnode_db 的存在性必须
     同进同退，绝不允许「提示词说接了库、工具却不在」或反过来。 */
  const dbGrounding = pureOn ? "" : agentDbGroundingNote(opts.node, boundWf);
  /* 第三个闸：按名字的隐藏名单（见 dshHiddenToolsFor） */
  const hideToolsOn = dshHiddenToolsFor({
    pure: pureOn,
    dbGrounded: !!String(dbGrounding || "").trim(),
    lean: leanOn,
    noCanvas: noCanvasOn,
    noCanvasRead: noReadOn,
  });
  /* 用户工具描述子（func call 单一真源，见 app-tools.js）：本轮绑定画布（= 会话所属画布）
     上的工具节点 + 工具库中开启「随时可调用」的工具。pure 会话不下发（网关不注入运行时，
     纯净模式只留联网搜索）。用 boundWf 而不是 S.wf：画布看着 A、工具与库接地按 B 的
     串台从此不可能 —— 描述子来自哪张图，tool-run 帧就只在那张图上找执行目标。 */
  const agentTools = pureOn
    ? { descs: [], byKey: {} }
    : await agentUserToolsSnapshot(boundWf);
  /* 并行运行:取消句柄按 runKey 隔离(会话=agent:<id>,节点=node.id,助手=assist)。
     systemPrompt 分节快照也以它为主键，故提前到 runParams 之前定型（取值口径一字未改）。 */
  const runKey = String(opts.runKey || (opts.node && opts.node.id) || "default");
  /* 分节装配要先有配置指纹（快照的准入条件），而 dshRunSigOf 先读基础七项
     （workspace/model/provider/preset/effort/pure/maxTokens）再读网关 runtimeKey
     同源成分 —— 先把它们全定成局部量，探针与 runParams 共用同一份取值：
     本轮探针与续跑重发之间这些成分若漂移，网关会另起 runtime（即便握手把旧会话
    恢复出来，也是旧配置的上下文），所以它们必须进签名（见 dshRunSigOf 注释）。 */
  const runModel = opts.model || d.model || "deepseek-v4-flash";
  const runMaxTokens = (() => {
    const t = effectiveDshMaxTokens(d.maxTokens);
    return t > 0 ? t : undefined;
  })();
  const runPreset = (() => {
    if (pureOn) return "pure";
    const p = opts.preset || d.preset || AGENT_PRESET_DEFAULT;
    /* 画布智能节点（nodeLock）跑内部 node 档：只办事不改图。判定 keyed 在「默认档」
       上而不是某个档名上 —— 默认档已从 standard 换成 minimal，老画布节点存的
       "standard" 与新默认都照常落到 node 档（行为逐字不变）；用户为节点显式
       挑选的其它档（code / cordis / lean）不改写。 */
    return nodeLock && (p === "standard" || p === AGENT_PRESET_DEFAULT)
      ? "node"
      : p;
  })();
  const runEffort = dshEffortOf(
    opts.effort,
    !!(opts.node && opts.node.kind === "proc_text"),
  );
  /* runtimeKey 同源成分的宿主侧取值（网关 getRuntime 的指纹输入，见 dshRunSigOf）：
     · apiKey / baseUrl / webSearchApiKey 上面已按路由定好（本路由密钥、端点、联网搜索 Key）；
     · persona = 本轮下发的宿主人设（主链路恒空，桌宠类独立进程由 main 直传 hostPersona）；
     · tools = 本轮工具描述子原文（网关 normRunTools → JSON 哈希 tl: 进 runtime key，
       工具集漂移 → 换 runtime 冷起 → 续跑点名撞 id collision，必须进签名）；
     · envPatch = 网关注入运行时的服务商密钥表 MTNODE_KEY_i 同源投影（= mtnodeProviders
       里每个可用服务商的 route/baseUrl/apiKey/api/models；key 表与端点模型任一漂移
       都让网关另起 runtime）。只取网关消费的字段，不含展示用 name。 */
  const runPersona = String(opts.persona || "").trim();
  const runToolsJson =
    agentTools.descs && agentTools.descs.length
      ? JSON.stringify(agentTools.descs)
      : "";
  const runEnvPatch =
    piProvs && piProvs.length
      ? JSON.stringify(
          piProvs.map((x) => ({
            route: x.route,
            baseUrl: x.baseUrl,
            apiKey: x.apiKey,
            api: x.api,
            models: x.models || [],
          })),
        )
      : "";
  const runSig = dshRunSigOf({
    workspace,
    model: runModel,
    provider,
    preset: runPreset,
    effort: runEffort,
    pure: pureOn,
    lean: leanOn,
    noCanvas: noCanvasOn,
    /* 名单通道也进签名：隐藏名单变化 = 网关 hx: 指纹变化 → 另起 runtime，点名续跑
       旧会话等于把别的可见集的上下文灌进本轮（与 lean / noCanvas 同一判据）。 */
    hide: hideToolsOn.join(","),
    maxTokens: runMaxTokens,
    /* runtimeKey 同源成分（漂移 = 网关换 runtime 冷起，握手恢复也只拿回旧配置的上下文，
       必须进签名 → 漂移即判整轮重发） */
    apiKey,
    baseUrl,
    webSearchKey: webSearchApiKey,
    persona: runPersona,
    tools: runToolsJson,
    envPatch: runEnvPatch,
  });
  /* 本轮下发的 systemPrompt 不是完整一节时（pure 轮整段置空；续跑轮的宿主人设已经落在
     那份 session 里，见 dshRunTask 的 systemPrompt:""），一律作废快照并走全量旁路 ——
     绝不允许「上一轮发过」被当成本轮可以省的依据。 */
  const resumeRound = !!String(opts.resumeSession || "").trim();
  if (pureOn || resumeRound) invalidatePromptSections(runKey);
  /* 七段片段来源与改造前一字不差，只把「顺序 + 丢空节 + 拼接」交给内核：
     节序即历史顺序（语言口味放最后，紧贴上下文尾部模型最容易照做），nodeLock 决定
     要不要 node_capability 节；diff 出厂关闭 → text 与旧的 join("\n\n") 逐字节等价。 */
  const promptSections = pureOn
    ? []
    : buildSections([
        {
          id: PROMPT_SECTION_IDS.persona_host,
          text: opts.systemPrompt || "",
        },
        { id: PROMPT_SECTION_IDS.skill_index, text: indexBlock },
        {
          id: PROMPT_SECTION_IDS.db_grounding,
          text: dbGrounding,
        },
        {
          id: PROMPT_SECTION_IDS.tool_policy,
          /* 「本轮不注册读画布工具」那句只在 Gate A 单独生效时说：一旦走整档闸
             （用户声明与画布无关 / 画布智能节点），连 mtnode_canvas_edit 都没注册，
             那句「收尾用 edit 改本节点」就成了假指令 —— 此时改由人设说明整档口径。 */
          text: agentToolPolicySystemNote({
            nodeLock,
            noCanvasRead: noReadOn && !noCanvasOn,
          }),
        },
        {
          id: PROMPT_SECTION_IDS.node_capability,
          text: nodeLock ? agentNodeCapabilityNote() : "",
        },
        {
          id: PROMPT_SECTION_IDS.plan_mode,
          text: opts.planMode ? planModeSystemNote() : "",
        },
        /* 语言口味放最后（节序表把它钉在末位）：紧贴上下文尾部，模型最容易照做 */
        { id: PROMPT_SECTION_IDS.lang_taste, text: agentLangTasteNote() },
      ]);
  const promptRender = pureOn
    ? null
    : renderSections(runKey, promptSections, { sig: runSig, full: resumeRound });
  const runParams = {
    workspace,
    input: String(input || ""),
    model: runModel,
    maxTokens: runMaxTokens,
    apiKey,
    baseUrl,
    webSearchApiKey,
    /* 工具节点函数调用清单：网关按指纹分池并注入运行时 tools-plugin.mjs */
    tools: agentTools.descs,
    systemPrompt: pureOn ? "" : promptRender.text,
    /* 跨轮注入预留的出参（runKey + sig + 每节哈希）：老网关忽略即降级保底，
       等 dsh 线协议支持 session 常驻后据此只重注变化分节 */
    sectionCache: pureOn ? undefined : promptRender.sectionCache,
    /* pure 标记必须原样下发网关：gateway 据此强制空预设文本，并给运行时进程
       注入 MTNODE_PURE（引擎侧 pure-prompt 插件与 cordis 门控全看这个环境变量）。
       此前 runParams 漏掉该字段 → 网关 pureFlag 恒为 false，纯净分支沦为死代码，
       这正是「纯净模式实现有误」的根因。 */
    pure: pureOn,
    /* 按运行裁剪可见工具集的两个整档标记（见上方 leanOn / noCanvasOn）：网关把它们
       注入 spawn env（MTNODE_LEAN_TOOLS / MTNODE_NO_CANVAS）并写进 runtime key。
       老网关忽略未知字段 = 全量注册，降级保底。 */
    lean: leanOn,
    noCanvas: noCanvasOn,
    /* 第三个通道：按名字的隐藏名单（见 dshHiddenToolsFor）。网关归一（白名单 + 去重
       + 排序）后进 runtime key 的 hx: 指纹并注入 MTNODE_HIDE_TOOLS；空名单不下发
       （= 老网关同一条路径，可见集一字不变）。 */
    hideTools: hideToolsOn.length ? hideToolsOn : undefined,
    preset: runPreset,
    effort: runEffort,
    provider,
    mtnodeProviders: piProvs,
    /* 允许单次运行显式覆盖权限档（如开发节点「问询」强制 read-only 只读回答）；
       未指定时沿用全局预设 / 节点自身设定 */
    permissionPreset:
      opts.permissionPreset || resolveNodePermissionPreset(opts.node, d),
    /* 图像输入(绝对路径,网关写入附件库后随消息发给视觉模型) */
    images:
      Array.isArray(opts.images) && opts.images.length
        ? opts.images.slice()
        : undefined,
    /* 断点续跑（重发闸的「优先续跑」分支）：点名沿用上一轮那条 dsh 会话，
       运行时带着原上下文继续，而不是新铸一个空会话。网关判它在本机不可续跑时
       以 RESUME_UNAVAILABLE 报错收轮、绝不静默新铸，由 dshRunTask 退回整轮重发。 */
    resumeSession: String(opts.resumeSession || "").trim() || undefined,
  };
  /* 本轮配置指纹：与网关报回的 session id 一起登记（见 captureRunSession），
     重发闸据此判断「这条会话还是不是这一套配置跑出来的」；runSig 已在分节装配前
     算出，口径 = dshRunSigOf 全量成分（含网关 runtimeKey 同源成分：apiKey / baseUrl /
     webSearchKey / persona / tools / envPatch）—— 这些漂移即换 runtime 冷起，
     握手恢复也只拿回旧配置的上下文，指纹变化正是退回整轮重发的判据。 */
  S._runSig = S._runSig || {};
  S._runSig[runKey] = runSig;
  /* 可续跑会话登记表：session 帧最先到达，done / error 上的 sessionId 兜底 */
  S._runSession = S._runSession || {};
  const captureRunSession = (id) => {
    const sid = String(id || "").trim();
    if (!sid) return;
    S._runSession[runKey] = { sid: sid, sig: runSig, at: Date.now() };
  };
  /* 本次 run 的工具定位表：tool-run 帧按描述子 key 回来时在这里找执行目标 */
  S._runToolDescs = S._runToolDescs || {};
  S._runToolDescs[runKey] = agentTools.byKey;
  /* 这一轮的「来自」归属：提问 / 审批卡片头部那行文案 + 点击跳转目标。
     runKey 已在组装 runParams 之前定型（会话 = agent:<id> / 节点 = node.id / 助手 = assist），
     这里只读不算，一次 run 定一次归属，后续推卡片直接复用。 */
  const ixSrc = dshIxSrcOf(opts, runKey);
  /* 起轮前的最后一道闸：装配这一大段（读盘 / 分节 / 工具快照）跑完，用户早就按过 ■ 了
     → 一个请求都不发。取消句柄此刻还没登记，网关侧的早到取消（wantCancelTag）只覆盖
     已送达网关的轮次，这段空白只能靠终止戳自己判。 */
  if (dshStopStamped(runKey, stopBase)) {
    if (S._runToolDescs) delete S._runToolDescs[runKey];
    return Promise.reject(new Error(I18n.t("已手动终止")));
  }
  /* 网关凭 cancelTag 精确关闭「这一次运行」自己的运行时进程。
     dsh 线协议没有逐轮取消，过去只能按工作目录整批关 → 停一个会话会把同目录的
     其它会话（含全局助手）一起打断。 */
  runParams.cancelTag = runKey;
  S._runCancels = S._runCancels || {};
  /* 本轮轨迹开一盏：按步切段的运行轨迹与取消句柄同键，互不串台。
     续跑那一轮（keepTrace）例外：失败轮已经写出来的前半正文必须留在轨迹里，
     续写接在后面，归档段才能还原「前半 + 续写后半」这条完整时间线。 */
  if (!opts.keepTrace) traceReset(runKey);
  /* 本次运行的唯一实例标识：同 runKey 可能被连续两轮复用（如「立即终止 + 立刻重发」），
     旧一轮的 finish 只能删自己的条目，绝不能误删新一轮的 —— 否则新一轮会被看门狗
     当成「已手动终止」、回复变成（已终止），两轮乱序。 */
  const runInst = {};
  S._runCancels[runKey] = {
    cancelTag: runKey,
    workspace: runParams.workspace,
    model: runParams.model,
    maxTokens: runParams.maxTokens,
    apiKey: runParams.apiKey,
    baseUrl: runParams.baseUrl,
    _runInst: runInst,
  };
  /* 本次运行的 Token 台账归属：会话 / 绑定节点的会话 / 全局助手 */
  const tokOwner =
    typeof tokOwnerForRun === "function" ? tokOwnerForRun(opts) : null;
  const t0 = Date.now();
  /* 交互面板:仅首个 run 清空,后续 run 保留其他会话/节点在途的提问与审批 */
  if (!(S._runCount || 0)) ixReset();
  S._runCount = (S._runCount || 0) + 1;
  if (opts.node && isAgentSuperPerm(opts.node) && opts.node.agentPermOutside === "ask") {
    if (S._agentPermSessionPaths) delete S._agentPermSessionPaths[opts.node.id];
  }
  /* 绑定本次运行的画布 = 上面解析出的会话所属画布：beginCanvasRun / endCanvasRun 继续成对
     （栈顶供「有画布写入在飞」判定与既有 canvas 事件路由用），用户中途切去别的画布干活
     也不会把本轮归属换成另一张图。 */
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
  /* 回滚账本：这一轮 run 开一盏账，并把 {sessionId, roundId} 随 run 交给网关 ——
     网关据此向该 runtime 的桥推 begin/end，运行时插件给每条 journal 盖章。
     老版网关不认这个字段就整个忽略（本轮只剩画布与清单可回退），不报错。 */
  let rbRound = null;
  try {
    if (typeof rbBeginRound === "function") {
      rbRound = rbBeginRound({
        runKey,
        workspace: runParams.workspace,
        node: opts.node || null,
        owner: opts.rollbackOwner || tokOwner || null,
        anchor: opts.rollbackAnchor || null,
        wfId: (boundWf && boundWf.id) || "",
        label: opts.rollbackLabel || "",
      });
      if (rbRound)
        runParams.rollback = {
          sessionId: rbRound.sessionId,
          roundId: rbRound.rid,
        };
    }
  } catch (_) {}
  return new Promise((resolve, reject) => {
    let settled = false;
    let seenError = "";
    /* 取消句柄消失的那一刻（0 = 句柄还在）：终止兜底从这一刻起算宽限，
       不看 lastActivity —— 见下方 watchdog 注释 */
    let cancelSeenAt = 0;
    /* SDK finalResponse 只含最后一条 assistant 正文;累计全部 text-delta 才是完整输出。
       续跑那一轮从已累计的半截正文起步（seedText），返回值才是整轮完整正文 */
    let accText = String(opts.seedText || "");
    /* 看门狗：网关 / 运行时卡住（harness.run 不返回、不发 done）时保证本轮一定收尾，
       渲染层绝不永久等待 —— 否则 assistRunning / st.running 残留 true，新消息全被丢弃，
       AI 回复永不追加，列表最底层永远停在旧会话内容（全局助手卡死 Bug 的根因）。
       - 终止宽限：用户点「■ 终止」后 dshCancelActive 会删掉 _runCancels 条目，
         若网关 N 秒内不响应取消 → 兜底强制 finish；
       - 静默超时：超过 DSH_RUN_IDLE_TIMEOUT_MS 无任何事件、且没有待处理提问/审批
         （模型在等用户回答是合法静默）→ 自动取消并终止。 */
    const DSH_WATCHDOG_INTERVAL_MS = 5000;
    const DSH_CANCEL_GRACE_MS = 10000;
    const DSH_RUN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
    /* 有未消费的提问 / 审批卡片时也设独立上限（模型在等用户，但引擎若挂起同样不能无限等） */
    const DSH_IX_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
    let lastActivity = Date.now();
    const finish = (ok, val) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      /* 本轮工具定位表只活到本轮结束：下一轮重收集（画布 / 工具库可能已变） */
      if (S._runToolDescs) delete S._runToolDescs[runKey];
      /* 只删自己这一轮登记的条目：同 runKey 的下一轮可能已覆盖它（见 runInst 注释），
         误删会让新一轮被看门狗当成「已手动终止」 */
      if (S._runCancels) {
        const cur = S._runCancels[runKey];
        if (cur && cur._runInst === runInst) delete S._runCancels[runKey];
      }
      S._runCount = Math.max(0, (S._runCount || 1) - 1);
      /* 本轮收尾只清自己这一轮(runKey)的提问 / 审批卡片:另一条在途会话的卡片保留,
         而本轮的卡片也不会因为「还有别的 run 活着」变成没人清的幽灵 */
      ixDropRun(runKey);
      /* 同理撤掉这一轮挂起的宿主确认框（画布修改 / 危险操作）：本轮已经封口，
         再留着就是一张点「确认」也没人回执的死框 */
      if (typeof canvasConfirmDropRun === "function")
        canvasConfirmDropRun(runKey);
      endCanvasRun(boundWf);
      if (scopeLock)
        S._canvasNodeAgentDepth = Math.max(
          0,
          (S._canvasNodeAgentDepth || 1) - 1,
        );
      /* 本轮跑完了（成功）：它登记的可续跑会话就此作废，绝不留给下一次运行 ——
         下一次是新的任务，拿旧会话续跑会把上一轮的上下文灌进来。
         失败收尾不清：正是失败那一轮留着的会话才是重发闸的续跑原料。 */
      if (ok && S._runSession) delete S._runSession[runKey];
      if (ok) resolve(val);
      else reject(val instanceof Error ? val : new Error(String(val || "")));
      /* 轮次封口：异步收口账本（等改前正文入完库 → rollbackDrain 补收迟到帧 → 落盘）。
         放在 resolve/reject 之后：回滚账本再慢/再坏也不影响这一轮的返回。 */
      try {
        if (rbRound && typeof rbEndRound === "function")
          Promise.resolve(rbEndRound(rbRound, ok ? "done" : "error")).catch(() => {});
      } catch (_) {}
    };
    const watchdog = setInterval(() => {
      if (settled) return;
      /* 每拍兜底自毁：网关被强杀 / 老版网关不发撤帧时 ix-drop 不会来，挂起的
         宿主确认框靠同一个判活口径（取消句柄是否还在）自动消失 */
      if (typeof canvasConfirmPruneOrphans === "function")
        canvasConfirmPruneOrphans();
      const h = S._runCancels && S._runCancels[runKey];
      const idle = Date.now() - lastActivity;
      if (!h || (h && h._runInst !== runInst)) {
        /* 条目被 dshCancelActive 删除 = 用户请求终止；或已被同 runKey 的新一轮覆盖。
           兜底收尾按「句柄消失多久」起算（cancelSeenAt），不看 lastActivity：本轮被判死之后
           网关若还在吐帧，idle 会被这些帧一路刷新，旧口径下「已请求终止」可以永远不落地
           （停止不生效、running 一直挂着、这一轮还占着重发判定）。 */
        if (!cancelSeenAt) cancelSeenAt = Date.now();
        if (Date.now() - cancelSeenAt >= DSH_CANCEL_GRACE_MS)
          finish(false, new Error(I18n.t("已手动终止")));
        return;
      }
      cancelSeenAt = 0;
      /* 模型等待用户回答（提问 / 审批）时没有任何事件，属合法静默：给一个更长的上限，
         引擎若在等待中挂起，也不能无限卡死 UI。
         只数本 runKey 的卡片：全局条数会把「别的会话正挂着提问」算进本轮静默，
         本轮的静默上限会从 30 分钟被莫名抬到 2 小时。 */
      const pendingIx = ((S.activeIx && S.activeIx.items) || []).filter(
        (x) => x && x.runKey === runKey,
      ).length;
      if (idle >= (pendingIx ? DSH_IX_WAIT_TIMEOUT_MS : DSH_RUN_IDLE_TIMEOUT_MS)) {
        try {
          dshCancelActive(runKey);
        } catch (_) {}
        finish(
          false,
          new Error(
            I18n.t(
              pendingIx
                ? "交互等待超时，已自动终止"
                : "运行长时间无响应，已自动终止",
            ),
          ),
        );
      }
    }, DSH_WATCHDOG_INTERVAL_MS);
    window.api
      .dshRun(
        runParams,
        (msg) => {
          if (msg.type === "journal") {
            /* 回滚 journal 帧：主进程已把改前正文入对象库，这里只按 rid 合并进本轮账本。
               不判 settled —— done 之后仍可能有帧挤进来，账本合并自身幂等。
               迟到帧不算「活动」：看门狗不能因为它们无限期续命。 */
            try {
              if (typeof rbCollectJournal === "function")
                rbCollectJournal(msg.data || {}, runKey);
            } catch (_) {}
            return;
          }
          if (settled) return;
          /* 任何业务事件（含 canvas / db 工具回执）都刷新看门狗的活动时间戳 */
          lastActivity = Date.now();
          /* 断点续跑的原料：网关在起真实轮之前就把本轮 dsh session id 报回来
             （session 帧，运行时自行改铸 id 时还会再报一次），done / error 上各带
             一份兜底 —— 拿到它，这一轮失败后才有可能接着写而不是从头再烧一遍。
             本轮成功结束时在 finish 里清掉这个键。 */
          if (msg.type === "session") {
            captureRunSession(msg.data && msg.data.sessionId);
          } else if (
            (msg.type === "done" || msg.type === "error") &&
            msg.data &&
            msg.data.sessionId
          ) {
            captureRunSession(msg.data.sessionId);
          }
          if (msg.type === "canvas") {
            /* 把这一轮的 runKey 与帧上的 sessionId 透传给宿主：确认框据此登记归属，
               本轮结束 / 被终止时才能自动撤框（见 app-nodes.js canvasConfirm*）。
               wf = 本轮绑定画布（= 会话「所属画布」）：画布写与应用写一律按它路由，
               不再依赖运行栈栈顶 —— 用户切去别的画布干活时，会话的改动仍精准命中
               它自己那张图，也绝不会顺手写进用户正开着的前台画布。 */
            handleCanvasEvent(msg.data || {}, {
              planMode: !!opts.planMode,
              runKey,
              sessionId: (msg.data && msg.data.sessionId) || "",
              wf: boundWf,
            });
            return;
          }
          if (msg.type === "db") {
            handleDbToolEvent(msg.data || {}, opts.node, boundWf);
            return;
          }
          if (msg.type === "tool-run") {
            /* 工具节点 func call：宿主执行节点内部图并回执结果；任何失败都以
               错误文本回执（会话不中断），见 app-tools.js handleToolRunEvent。
               执行目标按本轮绑定画布找（描述子就是从那张图收集的），不看 S.wf。 */
            try {
              handleToolRunEvent(msg.data || {}, {
                runKey,
                wf: boundWf,
                toolDescs: (S._runToolDescs && S._runToolDescs[runKey]) || {},
              });
            } catch (_) {}
            return;
          }
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
                  if (!handled) ixPush("approval", msg.data || {}, runKey, ixSrc);
                },
              );
              return;
            }
            ixPush("approval", msg.data || {}, runKey, ixSrc);
            return;
          }
          if (msg.type === "question") {
            ixPush(msg.type, msg.data || {}, runKey, ixSrc);
          }
          /* 运行时撤问(提问被中止 / 审批被取消):同步撤卡,别留幽灵卡片 */
          if (msg.type === "ix-drop") {
            const dropId = (msg.data && msg.data.id) || "";
            ixDrop(dropId);
            /* 网关撤销画布 / 危险操作帧时同样补发 ix-drop（data.kind = canvas）：
               那一帧的宿主确认框必须一起消失，不能等用户去点一个没人听的「确认」 */
            if (typeof canvasConfirmDrop === "function")
              canvasConfirmDrop(dropId);
            return;
          }
          /* Token 消耗实时入账（按模型），会话末尾的报告 Badge 靠它增长 */
          if (msg.type === "usage" && tokOwner && typeof tokLiveAdd === "function") {
            try { tokLiveAdd(tokOwner, msg.data || {}); } catch {}
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
          /* 按步切段的运行轨迹：所有 run（节点 / 会话 / 助手）都在此统一采集，
             再交给各自的 onEvent 做界面刷新 */
          try { traceFeedEvent(runKey, msg.type, msg.data || {}); } catch {}
          if (opts.onEvent) {
            try { opts.onEvent(msg.type, msg.data || {}); } catch {}
          }
          if (msg.type === "done") {
            /* 完成音效:仅当任务实际运行超过 5 分钟 */
            if (Date.now() - t0 >= 300000) playTaskDoneSound();
            const data = msg.data || {};
            /* 一轮结束：把本次用量按模型并进所属会话的累计台账 */
            if (tokOwner && typeof tokMergeRun === "function") {
              try { tokMergeRun(tokOwner, data.metrics, { startedAt: t0 }); } catch {}
            }
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
  /* 出错自动重发（dshRunTask 触发 retry 事件 · 需求「429 不跳过下一个任务」）：
     清不清残文看 resumed ——
     · resumed=true（续写）：新内容接在**同一条逻辑轮次**后面，已显示的部分正文 /
       工具清单 / 思考槽一律保留，这里什么都不清（清了等于把已经说出去的话抹掉）；
     · resumed=false（整轮重发）：上一失败轮的部分正文 / ⚠ 错误行 / 思考槽先清空，
       重发那一轮从零流式，不会把失败轮内容叠两遍；节点工具清单由 dshRunOnce 自行重置 */
  if (type === "retry") {
    if (data && data.resumed) return;
    node._pendingAnswer = "";
    if (S.thinking) {
      if (!S.thinking[node.id]) S.thinking[node.id] = [];
      S.thinking[node.id][attemptT || 0] = "";
    }
    const el = document.getElementById("dsh-out-stream-" + node.id);
    if (el) {
      el.classList.add("n-empty");
      el.textContent = "";
    }
    const nel = document.getElementById("agent-node-stream-" + node.id);
    if (nel) nel.textContent = "";
    autoFitOutputHeight(node);
    scrollAgentConv(node);
    return;
  }
  /* 思考流只装 reasoning：工具调用走 S.nodeTools 与运行轨迹的 tool 段，
     不再把「🔧 工具名」混进思考文本 */
  if (type === "reasoning" && data.text)
    pushThinking(node.id, attemptT || 0, data.text);
  const owner = ownerWfOfNode(node);
  const viewing = !!(owner && S.wf && owner.id === S.wf.id);
  /* 输出区按段渲染：轨迹里每个 say / err 段独立成段（段间空行），
     多次「思考 → 工具 → 说一段」不再被拼成一整坨连续文本 */
  const outText = () => traceSayDisplay(node.id, node._pendingAnswer);
  const paintStream = () => {
    const t = outText();
    const el = document.getElementById("dsh-out-stream-" + node.id);
    if (el) {
      el.classList.remove("n-empty");
      el.textContent = t;
    }
    const nel = document.getElementById("agent-node-stream-" + node.id);
    if (nel) nel.textContent = t;
    autoFitOutputHeight(node);
    scrollAgentConv(node);
  };
  if (type === "text" && data.text) {
    node._pendingAnswer = (node._pendingAnswer || "") + data.text;
    if (viewing) paintStream();
  }
  if (type === "error" && data && data.message) {
    if (node._aborted || isCancelishError(data.message)) return;
    node._pendingAnswer = (node._pendingAnswer || "") + "\n⚠ " + data.message;
    if (viewing) paintStream();
  }
  if (type === "reasoning" && viewing) {
    const think = document.getElementById("agent-node-think-" + node.id);
    if (think) {
      /* 内联思考块（CSS max-height:200px 独立滚动条）：以前每次写入都无条件
         scrollTop = scrollHeight，用户根本翻不上去。改为与会话侧同一套判定：
         贴底才跟随、上翻即脱离、滚回底部自动恢复。 */
      const tKey = "agent-node-think-" + node.id;
      think.textContent =
        traceThinkDisplay(node.id, thinkingTextOf(node)) || "";
      /* 节点重绘 → 全新元素（scrollTop 被冲成 0）：把用户的滚动位置搬回来 */
      if (think._convStickBound) stickScrollToBottom(think);
      else restoreStickPos(think, tKey);
      saveStickPos(think, tKey);
    }
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
  if (streamEl) streamEl.textContent = outText();
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
/* 一次 run 的来源归属 → 卡片头部那行「来自：」+ 点击跳转目标。
   并行运行时（多个会话 / 多个节点 / 助手同时在跑）不标来源，用户根本分不清
   是谁在等自己回答。分类口径与运行队列（collectRunQueueAll）保持一致：
     - opts.node                     画布上的智能节点（agent_task / 智能文本 / 计划节点模式）
     - runKey === "assist"           全局助手
     - runKey === "agent:<id>"       智能会话；带 _devContract = 开发 / 细化绑定会话
     - runKey === "devsuggest:<id>"  功能块的「建议」只读调研
     - runKey === "devask:<id>"      功能块的「问询」只读回答
   其余（如计划并行子任务）拿不到更细的归属 → label 留空，卡片不显示来源行。 */
function dshIxSrcOf(opts, runKey) {
  const key = String(runKey || "");
  const src = { type: "", label: "", id: "", wfId: "", hint: "" };
  /* 标题可能很长（会话标题常被拿首句当名）：卡片只有一行，掐断加省略号 */
  const clip = (s) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > 24 ? t.slice(0, 24) + "…" : t;
  };
  const wfOf = (n) => {
    try {
      return typeof ownerWfOfNode === "function" ? ownerWfOfNode(n) : S.wf;
    } catch (_) {
      return S.wf;
    }
  };
  try {
    const node = opts && opts.node;
    if (node && node.id) {
      const w = wfOf(node);
      const name = clip(node.title) || I18n.t("（未命名）");
      const wfName = String((w && (w.name || w.id)) || "");
      src.type = "node";
      src.id = String(node.id);
      src.wfId = (w && w.id) || "";
      /* 画布名一并带上：跨画布运行时只给节点标题照样找不到人在哪 */
      src.label = wfName
        ? I18n.t("智能节点「{n}」· {w}", { n: name, w: wfName })
        : I18n.t("智能节点「{n}」", { n: name });
      src.hint = I18n.t("点击定位到节点");
      return src;
    }
    if (key === "assist") {
      src.type = "assist";
      src.label = I18n.t("全局助手");
      src.hint = I18n.t("点击打开全局助手");
      return src;
    }
    if (key.indexOf("agent:") === 0) {
      const sid = key.slice(6);
      const st =
        typeof agentSessionById === "function" ? agentSessionById(sid) : null;
      const name = clip((st && st.title) || "") || I18n.t("（未命名）");
      src.type = "session";
      src.id = String((st && st.id) || sid);
      /* 开发 / 细化绑定会话：任务书契约挂在 _devContract 上，必须一眼区别于普通会话 */
      src.label =
        st && st._devContract
          ? I18n.t("开发/细化会话「{n}」", { n: name })
          : name;
      src.hint = I18n.t("点击打开该会话");
      return src;
    }
    const dm = /^dev(suggest|ask):(.+)$/.exec(key);
    if (dm) {
      const n =
        typeof runQueueLookupNode === "function"
          ? runQueueLookupNode(dm[2])
          : typeof nodeById === "function"
            ? nodeById(dm[2])
            : null;
      const name = clip((n && n.title) || "") || I18n.t("（未命名）");
      const w = n ? wfOf(n) : S.wf;
      src.type = "dev";
      src.id = dm[2];
      src.wfId = (w && w.id) || "";
      src.label =
        dm[1] === "suggest"
          ? I18n.t("功能块「{n}」的建议", { n: name })
          : I18n.t("功能块「{n}」的问询", { n: name });
      src.hint = I18n.t("点击查看调研进度");
      return src;
    }
    return src;
  } catch (_) {
    return src;
  }
}
/* 点卡片来源行：跳回发起这一轮的地方。跳转口径抄运行队列（jumpRunQueueItem）：
   会话 → 切 agent 视图并置为活动会话；节点 → 切回画布、跨画布先 loadWorkflow、
   再 focusNode 让镜头定位；助手 → 打开助手抽屉。全部 try 住，目标可能已经没了。 */
async function ixSrcJump(src) {
  if (!src || !src.type) return;
  try {
    if (src.type === "assist") {
      if (typeof setAssistOpen === "function") setAssistOpen(true);
      return;
    }
    if (src.type === "session") {
      const st =
        typeof agentSessionById === "function"
          ? agentSessionById(src.id)
          : null;
      if (!st) {
        toast(I18n.t("会话已不存在"), "warn");
        return;
      }
      if (typeof setView === "function" && S.view !== "agent")
        setView("agent");
      S.agentActiveId = st.id;
      if (typeof persistAgentSession === "function") await persistAgentSession();
      if (typeof renderAgentSession === "function") renderAgentSession();
      if (typeof renderAgentSessionSidebar === "function")
        renderAgentSessionSidebar();
      return;
    }
    const n =
      (typeof runQueueLookupNode === "function"
        ? runQueueLookupNode(src.id)
        : null) ||
      (typeof nodeById === "function" ? nodeById(src.id) : null);
    if (!n) {
      toast(I18n.t("节点已不存在"), "warn");
      return;
    }
    if (typeof setView === "function" && S.view === "agent")
      setView("workflow");
    if (src.wfId && S.wf && src.wfId !== S.wf.id && typeof loadWorkflow === "function")
      await loadWorkflow(src.wfId);
    if (typeof focusNode === "function") focusNode(n.id);
    /* 功能块的「建议 / 问询」在跑：定位节点之外再打开那个进度窗口（与队列点行一致） */
    if (src.type === "dev") {
      try {
        if (
          typeof devSuggestJobBusy === "function" &&
          typeof devSuggestShowJob === "function" &&
          devSuggestJobBusy(n)
        ) {
          devSuggestShowJob(devSuggestJobBusy(n));
        } else if (
          typeof devAskJobBusy === "function" &&
          typeof devAskShowJob === "function" &&
          devAskJobBusy(n)
        ) {
          devAskShowJob(devAskJobBusy(n));
        }
      } catch (_) {}
    }
  } catch (_) {
    toast(I18n.t("节点不在当前画布"), "warn");
  }
}
/* 「稍后（终止本轮）」出口：提问 / 审批都是运行时进程在等一次回答，线协议里没有
   「挂起、回头再答」这一档 —— 唯一的「先放着」就是把这一轮停下来（之后用户重发）。
   只取消这一轮自己的 runKey，同目录其它在途运行不受影响。 */
function ixDeferRun(it) {
  const runKey = String((it && it.runKey) || "");
  if (it && it.data && it.data.id) ixDrop(it.data.id);
  try {
    if (runKey) dshCancelActive(runKey);
  } catch (_) {}
  toast(I18n.t("已稍后处理：本轮已终止"), "ok");
}
function ixReset() {
  S.activeIx = { items: [] };
  renderIxPanel();
}
function ixPush(kind, data, runKey, src) {
  if (!S.activeIx) S.activeIx = { items: [] };
  /* 先清孤儿卡，再决定这张要不要收 */
  ixPruneOrphanCards();
  /* 发起轮已经结束（取消句柄被删）→ 这一帧的答案注定没人接，
     收进来就是一张点了没反应的死卡，直接丢弃 */
  const deadRun = !!runKey && !(S._runCancels && S._runCancels[runKey]);
  if (!deadRun) {
    /* 记下这张卡片属于哪一次运行(runKey):收尾时只清自己这轮的,
       避免一条会话结束误清另一条在途会话的提问;src 是它的「来自：」归属（卡片头部一行） */
    S.activeIx.items.push({
      kind,
      data,
      runKey: runKey || "",
      src: src && src.label ? src : null,
    });
    playIxSound();
  }
  renderIxPanel();
}
function ixDrop(id) {
  if (!S.activeIx) return;
  S.activeIx.items = S.activeIx.items.filter((x) => x.data.id !== id);
  renderIxPanel();
}
function ixDropRun(runKey) {
  if (!runKey || !S.activeIx || !S.activeIx.items.length) return;
  /* 按 runKey 过滤:只清这一轮推上来的卡片,其余在途运行的卡片保留 */
  const items = S.activeIx.items.filter((x) => x.runKey !== runKey);
  if (items.length === S.activeIx.items.length) return;
  S.activeIx.items = items;
  renderIxPanel();
}
/* 本地兜底撤卡：卡片所属那一轮的取消句柄已经不在 _runCancels 里 = 那一轮已经结束
   （正常收尾 / 用户点终止 / 看门狗兜底），网关的 ix-drop 却没来（进程被强杀、
   老版网关不认识撤卡帧）。这种卡点任何选项都会撞「交互已失效」，是永不消失的死卡，
   所以在每次推送与重绘前先把孤儿卡清掉。runKey 为空的卡不做归属判定，保留。
   返回是否删过，由调用方决定是否重绘（本函数不自己重绘，避免递归）。 */
function ixPruneOrphanCards() {
  if (!S.activeIx || !S.activeIx.items || !S.activeIx.items.length) return false;
  const live = S._runCancels || {};
  const items = S.activeIx.items.filter((x) => !x.runKey || live[x.runKey]);
  if (items.length === S.activeIx.items.length) return false;
  S.activeIx.items = items;
  return true;
}
/* 宿主确认框（画布修改 / 危险操作）与卡片共用同一套判活口径，挂在同一清理节奏上。
   注意：即使本轮没有任何提问卡片也要扫 —— 否则「只弹确认框、没弹提问」的死框
   永远等不到清理入口。 */
function ixPruneAllInteraction() {
  ixPruneOrphanCards();
  if (typeof canvasConfirmPruneOrphans === "function")
    canvasConfirmPruneOrphans();
}
/* 交互回执统一收尾：无论网关说 stale（pending 已没了）还是真失败，这张卡都不该
   再留在屏上 —— 网关侧没人接这帧，继续显示只会变成点了没反应的死卡。 */
function ixFinalizeCard(it, why) {
  if (it && it.data && it.data.id) ixDrop(it.data.id);
  if (why) toast(why, "warn");
}
/* 幂等：一次点击只发一帧。重复点击既没有意义（网关侧 pending 已删），
   也会让第二次必然撞上 stale。返回 true = 本次是首次提交，可以发帧。 */
function ixMarkFirstSend(it) {
  if (!it || it._ixSent) return false;
  it._ixSent = true;
  return true;
}
function ixAnswerQuestion(it) {
  if (!ixMarkFirstSend(it)) return;
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
      if (res && res.stale)
        return ixFinalizeCard(it, I18n.t("该询问已失效（发起轮已结束）"));
      if (res && res.ok === false) throw new Error(res.error);
      ixDrop(it.data.id);
    })
    .catch((e) =>
      ixFinalizeCard(
        it,
        I18n.t("回答失败：") + ((e && e.message) || String(e)),
      ),
    );
}
function ixAnswerApproval(it, outcome) {
  if (!ixMarkFirstSend(it)) return;
  window.api
    .dshInteract({ kind: "approval", id: it.data.id, outcome })
    .then((res) => {
      if (res && res.stale)
        return ixFinalizeCard(it, I18n.t("该询问已失效（发起轮已结束）"));
      if (res && res.ok === false) throw new Error(res.error);
      ixDrop(it.data.id);
    })
    .catch((e) =>
      ixFinalizeCard(
        it,
        I18n.t("审批失败：") + ((e && e.message) || String(e)),
      ),
    );
}
/* 「稍后（终止本轮）」出口：提问 / 审批都只有这一次运行的进程在等回答，
   来不及处理时不能把卡片晾在这儿（看门狗只能按 2 小时上限兜底），
   所以两种卡片的按钮行末尾都给一个「稍后」—— 撤卡 + 终止这一轮自己。 */
function ixLaterButton(it) {
  const b = document.createElement("button");
  b.className = "mini ix-later";
  b.textContent = I18n.t("稍后（终止本轮）");
  b.title = I18n.t("先不回答：终止发起这张卡片的这一轮运行");
  b.onclick = () => ixDeferRun(it);
  return b;
}
/* ── 「中断任务」出口 ──
   与「稍后」的区别（写在中断按钮的 title 提示里）：稍后 = 暂时不答、把这轮停掉；
   中断 = 明确放弃这次提问，并给运行时一个**失败**回执 —— 先发 kind:'abort'
   （网关 gateway.mjs 的 interact 与桥侧 t:'abort' 都已支持：ask_user_question 直接
   reject，而不是回一份空 selected 的答案把模型骗过去继续跑），
   再终止发起这张卡片的那一轮，最后撤掉该轮全部卡片
   （网关的 ix-drop 可能因进程被强杀而不来，这里本地兜底，绝不留死卡）。 */
function ixAckAbort(it) {
  const id = it && it.data && it.data.id;
  if (!id || it._ixSent) return; /* 已回答 / 已中断过的卡不再发第二帧 */
  it._ixSent = true;
  try {
    Promise.resolve(window.api.dshInteract({ kind: "abort", id })).catch(() => {});
  } catch (_) {}
}
function ixAbortRun(it) {
  ixAckAbort(it);
  const runKey = String((it && it.runKey) || "");
  if (!runKey) {
    /* 归属丢失的卡：无轮可停，撤卡 + 已发中止回执即可 */
    if (it && it.data && it.data.id) ixDrop(it.data.id);
    toast(I18n.t("已中断该询问"), "ok");
    return;
  }
  try {
    dshCancelActive(runKey);
  } catch (_) {}
  ixDropRun(runKey);
  toast(I18n.t("已中断任务：本轮已终止"), "ok");
}
/* 面板头部「全部中断」：多条运行并行时逐轮执行同样的动作，不用一张张点 */
function ixAbortAllRuns() {
  const items = ((S.activeIx && S.activeIx.items) || []).slice();
  if (!items.length) return;
  const keys = [];
  for (const it of items) {
    ixAckAbort(it);
    const k = String(it.runKey || "");
    if (k && !keys.includes(k)) keys.push(k);
  }
  for (const k of keys) {
    try {
      dshCancelActive(k);
    } catch (_) {}
  }
  ixReset();
  toast(
    I18n.t("已中断全部在途任务（{n} 轮）", { n: keys.length || items.length }),
    "ok",
  );
}
function ixAbortButton(it) {
  const b = document.createElement("button");
  b.className = "mini danger ix-abort";
  b.textContent = I18n.t("中断任务");
  b.title = I18n.t(
    "中断：撤掉本轮全部询问并终止这一轮，模型侧收到「已中断」失败回执（不同于「稍后」）",
  );
  b.onclick = () => ixAbortRun(it);
  return b;
}
function renderIxPanel() {
  /* 每次重绘先做一次孤儿清理（网关没发撤卡帧时的本地兜底）：提问 / 审批卡片
     与宿主确认框一起扫 —— 只有确认框、没有卡片时本函数也会被 ixReset 带进来 */
  ixPruneAllInteraction();
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
  const headTxt = document.createElement("span");
  headTxt.className = "ix-head-txt";
  headTxt.textContent =
    I18n.t("🐋 模型等待你的回应（") + items.length + I18n.t(" 项）");
  head.appendChild(headTxt);
  /* 头部总出口：一次性中断所有在途询问（逐轮发 abort + 停轮） */
  const abortAll = document.createElement("button");
  abortAll.className = "mini danger ix-abort ix-abort-all";
  abortAll.textContent = I18n.t("全部中断");
  abortAll.title = I18n.t("中断所有在途运行并撤掉它们的全部询问卡片");
  abortAll.onclick = () => ixAbortAllRuns();
  head.appendChild(abortAll);
  box.appendChild(head);
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "ix-card";
    card.id = "ixCard_" + it.data.id;
    /* 来源行放卡片最顶：多条运行并行时先回答「这是谁在问」，点一下跳回去 */
    if (it.src && it.src.label) {
      const s = document.createElement("div");
      s.className = "ix-src";
      s.textContent = I18n.t("来自：") + it.src.label;
      if (it.src.hint) s.title = it.src.hint;
      s.onclick = () => ixSrcJump(it.src);
      card.appendChild(s);
    }
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
      row.appendChild(ixLaterButton(it));
      row.appendChild(ixAbortButton(it));
      card.appendChild(row);
    } else {
      const d = it.data;
      const qs = d.questions || [];
      /* radio 的 name 是整个 document 的互斥域：原来只用 "ix_" + q.id，
         两条并行运行的题 id 常常都是 q1 / confirm —— B 卡一选就把 A 卡的选中取消，
         A 卡提交时 inp.checked 全 false → selected 空 → 模型收到空答案，
         表现正是「任何选项都不起作用」。分组键必须是「卡片 id + 卡内题序」。 */
      const ixGroup = "ix_" + String(d.id || "card") + "_";
      let ixQi = 0;
      for (const q of qs) {
        const qGroup = ixGroup + ixQi++;
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
            cb.name = qGroup;
            cb.value = o.label;
            cb.dataset.qid = q.id;
            /* 选项做成「勾选框 + 两行文字列」：第二行显示 description（一句话理由）。
               原来理由只挂在 title 上，鼠标不悬停就看不到 —— 需求拷问（grill-me）
               整轮的推荐依据全指望这一句，看不到等于没问。 */
            const txt = document.createElement("span");
            txt.className = "ix-opt-label";
            txt.textContent = o.label;
            if (o.description) {
              const d = document.createElement("span");
              d.className = "ix-opt-desc";
              d.textContent = o.description;
              txt.appendChild(d);
              lab.title = o.description;
            }
            lab.appendChild(cb);
            lab.appendChild(txt);
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
      row.appendChild(ixLaterButton(it));
      row.appendChild(ixAbortButton(it));
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



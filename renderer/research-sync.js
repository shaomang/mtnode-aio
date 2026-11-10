/* 同步下游（downstream sync）· window.MTResearchSync
 *
 * 一句话：上游笔记改了一段，凡是**下游衍生物 / 参考内容**里还留着这段旧字句的地方，
 * 都记进 research/sync.json，顶栏冒一颗「同步下游 · N」；勾选后逐项交给 subagent
 * **原地改写**（不另存 v2），每项各记一条 changes.jsonl（撤销照样能一条条退回去）。
 *
 * 为什么不是「保存完直接让 agent 全量重写下游」：
 *   · 全量重写既贵又不可控（会把没改的段落一起改掉），用户也没法只同步他认的那几处；
 *   · 判据必须是**能复算的东西** —— 归一后的 n-gram 指纹，谁都能在页面上对得上，
 *     而不是「模型觉得这段过时了」。
 *
 * 口径（三段是一份判定，改数字要连着改下面注释）：
 *   · 归一：去空白与标点（只留字母 / 数字 / 汉字）、压平大小写 ——「剪枝 界限」与
 *     「剪枝界限」是同一串；中文没空格，标点一去掉，逐字比对才不会被排版差异骗过去。
 *   · NGRAM=8：归一后连续 8 个字算一片指纹；一段话 → 一个指纹集合。
 *   · SEED=16：16 个字**逐字**相同才算「真引用了这句」；普通笔记（同主题、泛泛相似）
 *     靠它过滤，不然每篇讲同一课题的笔记都会被判成「受影响的引用」。
 *   · 衍生物（frontmatter parent / derives 链的下游）放宽到 2 片 + 占全文指纹 5%：
 *     衍生物本来就会改写措辞，指纹本来就稀。
 *
 * 文件：
 *   research/sync.json                 待同步清单（应用独占：命中项、状态、差异摘要）
 *   research/sync/task.json            这一次派活的清单（agent 只读）
 *   research/sync/result.json          每一项的结果（agent 独占：done / failed + 原因）
 *   research/sync/before/<hash>.md     同步前快照（changes.jsonl 的 before 用它，撤销才完整）
 *
 * 为什么拆 task / result 两个文件：清单与应用状态不能两边抢着写。应用只写 sync.json 与
 * task.json，agent 只写 result.json，轮询的人只做合并 —— 没有并发覆盖的窗口。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTResearchSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NGRAM = 8;
  const SEED = 16;
  const MIN_PARA = 24; /* 太短的段落不进比对：一句「见上节」会命中一切 */
  const MIN_HITS = 2; /* 衍生物：至少 2 片指纹 */
  const MIN_RATIO = 0.05;
  const STRONG_HITS = 3; /* 其它文档：至少 3 片，且必须有 16 字逐字相同 */
  const MAX_TEXT = 2400; /* 清单里存的段落上限 */
  const MAX_ITEMS = 80;
  const POLL_MS = 1500;
  const MAX_WAIT_MS = 8 * 60 * 1000;
  const MAX_DEPTH = 3; /* 衍生物往下数 3 层 */

  /* ── 文本小工具 ── */
  function str(v) {
    return String(v == null ? "" : v);
  }
  function normRel(p) {
    return str(p)
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "")
      .replace(/\/{2,}/g, "/")
      .trim();
  }
  /* 归一：只留字母 / 数字 / 汉字（标点、空白、符号全去掉） */
  function norm(s) {
    return str(s)
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }
  function clipText(s, n) {
    const t = str(s).replace(/\s+/g, " ").trim();
    const max = Math.max(8, Number(n) || 80);
    return t.length > max ? t.slice(0, max) + "…" : t;
  }
  function hashString(s) {
    const t = str(s);
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /* ── 段落切分（frontmatter 之后的空行分段；标题单独成段并打 heading 标记）── */
  function paragraphs(md) {
    const text = str(md).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    let start = 0;
    if (/^---[ \t]*$/.test(lines[0] || "")) {
      for (let i = 1; i < lines.length; i++) {
        if (/^---[ \t]*$/.test(lines[i])) {
          start = i + 1;
          break;
        }
      }
    }
    const out = [];
    let buf = [];
    let bufLine = 0;
    let fence = false;
    const flush = () => {
      const raw = buf.join("\n").trim();
      if (raw) out.push({ text: raw, line: bufLine, norm: norm(raw), heading: false });
      buf = [];
      bufLine = 0;
    };
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      const isFence = /^\s*```/.test(line);
      if (isFence) {
        fence = !fence;
      } else if (!fence) {
        if (!line.trim()) {
          flush();
          continue;
        }
        if (/^\s*#{1,6}\s+/.test(line)) {
          flush();
          out.push({ text: line.trim(), line: i + 1, norm: norm(line), heading: true });
          continue;
        }
      }
      if (!buf.length) bufLine = i + 1;
      buf.push(line);
    }
    flush();
    return out;
  }

  /* ── 指纹 ── */
  function gramsOf(normText, n) {
    const s = str(normText);
    const size = Math.max(1, n || NGRAM);
    const out = new Set();
    for (let i = 0; i + size <= s.length; i++) out.add(s.slice(i, i + size));
    return out;
  }
  function countHits(a, b) {
    let n = 0;
    const small = a.size <= b.size ? a : b;
    const big = small === a ? b : a;
    for (const g of small) if (big.has(g)) n++;
    return n;
  }

  /* 差异摘要：掐掉公共前缀与后缀，只留「改了什么」中间那一段 */
  function diffBrief(a, b) {
    const A = str(a).replace(/\s+/g, " ").trim();
    const B = str(b).replace(/\s+/g, " ").trim();
    let i = 0;
    const maxI = Math.min(A.length, B.length);
    while (i < maxI && A.charAt(i) === B.charAt(i)) i++;
    let j = 0;
    const maxJ = Math.min(A.length - i, B.length - i);
    while (j < maxJ && A.charAt(A.length - 1 - j) === B.charAt(B.length - 1 - j)) j++;
    return {
      oldMid: clipText(A.slice(i, A.length - j) || A, 120),
      newMid: clipText(B.slice(i, B.length - j) || B, 120),
      same: i + j,
      oldLen: A.length,
      newLen: B.length,
    };
  }

  /* ── 衍生物关系：parent / parents / derivedFrom（子记父）+ derives（父记子）── */
  function refResolver(docs) {
    const byPath = new Map();
    const byTitle = new Map();
    for (const d of docs || []) {
      const p = normRel(d.path);
      if (!p) continue;
      byPath.set(p, p);
      if (/\.md$/i.test(p)) byPath.set(p.replace(/\.md$/i, ""), p);
      const title = str(d.title).trim();
      if (title) byTitle.set(title, p);
      const label = str(d.label).trim();
      if (label) byTitle.set(label, p);
    }
    return function resolve(ref) {
      const raw = str(ref)
        .trim()
        .replace(/^\[\[|\]\]$/g, "")
        .trim();
      if (!raw) return "";
      const cands = [normRel(raw)];
      if (!/\.md$/i.test(raw)) cands.push(normRel(raw + ".md"));
      for (const dir of ["notes/", "core/"]) {
        cands.push(normRel(dir + raw));
        if (!/\.md$/i.test(raw)) cands.push(normRel(dir + raw + ".md"));
      }
      for (const c of cands) if (byPath.has(c)) return byPath.get(c);
      return byTitle.get(raw) || "";
    };
  }
  function isRefPath(path) {
    return /^literature\//i.test(normRel(path));
  }
  /* from 的下游：父 -> 子（子里写 parent，或父里写 derives），最多 MAX_DEPTH 层 */
  function downstreamSet(docs, from) {
    /* 「上游」那篇自己不一定在 docs 里（扫描时它被排除了）：
       解析 parent 前先把它按路径补进去，否则 notes/10-x.md 这种写法一条都解析不出来。 */
    const all = (docs || []).slice();
    const fromPath = normRel(from);
    if (fromPath && !all.some((d) => normRel(d.path) === fromPath)) all.push({ path: fromPath, md: "" });
    const resolve = refResolver(all);
    const parentsOf = new Map();
    const addParent = (child, parent) => {
      const c = normRel(child);
      const p = normRel(parent);
      if (!c || !p || c === p) return;
      if (!parentsOf.has(c)) parentsOf.set(c, new Set());
      parentsOf.get(c).add(p);
    };
    for (const d of docs || []) {
      const path = normRel(d.path);
      if (!path) continue;
      for (const ref of d.parents || []) {
        const p = resolve(ref);
        if (p) addParent(path, p);
      }
      /* 父笔记反记 derives: [衍生物] —— 那一条写在父这边，指的方向是「子」 */
      for (const ref of d.derives || []) {
        const child = resolve(ref);
        if (child) addParent(child, path);
      }
    }
    const out = new Set();
    let frontier = [fromPath];
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const next = [];
      for (const [child, ps] of parentsOf) {
        if (out.has(child)) continue;
        for (const p of ps) {
          if (frontier.indexOf(p) < 0) continue;
          out.add(child);
          next.push(child);
          break;
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    return out;
  }

  /* ── 变更段落：把「改前的那一段」和「改后的那一段」配成一对 ──
   * 关键点：下游文档里留的是**旧文字**。所以要比对的是 oldNorm（旧版本），
   * 新文字只作为「应该改成什么」交给 agent —— 拿新文字去扫下游永远扫不到东西
   * （除非它已经被同步过一次），这是最容易写反的一处。 */
  function paragraphPairs(before, after) {
    const bp = paragraphs(before).filter((p) => !p.heading && p.norm.length >= MIN_PARA);
    const ap = paragraphs(after).filter((p) => !p.heading && p.norm.length >= MIN_PARA);
    const bNorm = new Set(bp.map((p) => p.norm));
    const aNorm = new Set(ap.map((p) => p.norm));
    const used = new Set();
    const out = [];
    for (let i = 0; i < ap.length; i++) {
      const p = ap[i];
      if (bNorm.has(p.norm)) continue; /* 这一段没动 */
      const g = gramsOf(p.norm, NGRAM);
      let best = null;
      let bestRatio = 0;
      for (const q of bp) {
        if (aNorm.has(q.norm) || used.has(q.norm)) continue;
        const ratio = countHits(g, gramsOf(q.norm, NGRAM)) / Math.max(1, g.size);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = q;
        }
      }
      if (!best || bestRatio < 0.15) {
        /* 整段重写时指纹对不上：退到「同一个位置」的旧段落（仍要求它已经不在新文里） */
        const q = bp[i];
        best = q && !aNorm.has(q.norm) && !used.has(q.norm) ? q : null;
        bestRatio = 0;
      }
      if (!best) continue; /* 纯新增：下游没有旧字句可对，不同步 */
      used.add(best.norm);
      out.push({
        kind: "edit",
        oldText: best.text,
        oldNorm: best.norm,
        newText: p.text,
        oldLine: best.line,
        srcLine: p.line,
      });
    }
    for (const q of bp) {
      if (aNorm.has(q.norm) || used.has(q.norm)) continue;
      out.push({ kind: "removed", oldText: q.text, oldNorm: q.norm, newText: "", oldLine: q.line, srcLine: 0 });
    }
    return out;
  }

  /* ── 扫描：变更段落 × 下游文档 → 待同步项 ──
   * input: { from, before, after, docs:[{path,title,md,parents,derives}] } */
  function scan(input) {
    const opt = input || {};
    const from = normRel(opt.from);
    if (!from) return [];
    const changed = paragraphPairs(opt.before, opt.after);
    if (!changed.length) return [];
    for (const c of changed) {
      c.g8 = gramsOf(c.oldNorm, NGRAM);
      c.g16 = gramsOf(c.oldNorm, SEED);
      delete c.oldNorm;
    }

    const docs = (opt.docs || []).filter((d) => d && d.md != null && normRel(d.path) !== from);
    if (!docs.length) return [];
    const down = downstreamSet(docs, from);

    const items = [];
    const seen = new Map(); /* doc#line → item（同一段只留命中率最高的一条） */
    for (const d of docs) {
      const dPath = normRel(d.path);
      const rel = down.has(dPath) ? "derived" : isRefPath(dPath) ? "reference" : "quote";
      for (const p of paragraphs(d.md)) {
        if (p.heading || !p.norm || p.norm.length < MIN_PARA) continue;
        let g8 = null;
        let g16 = null;
        for (const c of changed) {
          g8 = g8 || gramsOf(p.norm, NGRAM);
          const hits = countHits(c.g8, g8);
          if (!hits) continue;
          const ratio = hits / Math.max(1, c.g8.size);
          if (rel === "derived") {
            if (hits < MIN_HITS || ratio < MIN_RATIO) continue;
          } else {
            if (hits < STRONG_HITS) continue;
            g16 = g16 || gramsOf(p.norm, SEED);
            if (!countHits(c.g16, g16)) continue;
          }
          const key = dPath + "#" + p.line;
          const prev = seen.get(key);
          if (prev && prev.ratio >= ratio) continue;
          const item = {
            id: "s" + hashString(from + "|" + dPath + "|" + p.line),
            from,
            doc: dPath,
            title: str(d.title) || dPath,
            kind: rel,
            line: p.line,
            oldText: clipText(p.text, MAX_TEXT),
            newText: c.kind === "removed" ? "" : clipText(c.newText, MAX_TEXT),
            change: c.kind,
            srcLine: c.srcLine,
            ratio: Math.round(ratio * 100) / 100,
            diff: diffBrief(p.text, c.kind === "removed" ? "" : c.newText),
            ts: Date.now(),
          };
          seen.set(key, item);
          /* 同一篇同一段后来居上：先删掉旧位置的那条 */
          if (prev) {
            const at = items.indexOf(prev);
            if (at >= 0) items.splice(at, 1);
          }
          items.push(item);
        }
      }
    }
    return items;
  }

  /* 这一条现在还「对不上」吗：文档里那段还是旧的（或已经被人改掉了） */
  function stillStale(md, item) {
    const want = norm(item.oldText);
    if (!want) return false;
    const w8 = gramsOf(want, NGRAM);
    for (const p of paragraphs(md)) {
      if (p.heading || !p.norm) continue;
      if (p.norm === want) return true;
      if (Math.abs(p.norm.length - want.length) > want.length) continue;
      const hits = countHits(w8, gramsOf(p.norm, NGRAM));
      if (hits >= MIN_HITS && hits / Math.max(1, w8.size) >= MIN_RATIO) return true;
    }
    return false;
  }

  /* ── 视图层 ── */
  function create(ctx) {
    const t = (s) => (ctx.t ? ctx.t(s) : s);
    const el = ctx.el;
    const RS = () => (ctx.state ? ctx.state() : {}) || {};
    const api = () => (ctx.api ? ctx.api() : null) || (typeof window !== "undefined" ? window.api : null) || {};
    const joinP = (...parts) => ctx.joinP(...parts);
    const toast = (msg, kind) => {
      if (ctx.toast) ctx.toast(msg, kind);
    };

    const SY = {
      root: "",
      items: [],
      loaded: false,
      loading: null,
      panel: null,
      timer: null,
      busy: false,
      session: "",
      img: new Map(),
      pending: new Map(),
      saveTimer: null,
      docsCache: null,
      docsAt: 0,
      onKey: null,
    };

    /* ── 文件小工具（只走 window.api，不碰 node）── */
    async function readText(abs) {
      const a = api();
      if (!a || typeof a.fileReadText !== "function") return "";
      const r = await a.fileReadText(abs);
      return r && r.exists ? str(r.content) : "";
    }
    async function writeText(abs, text) {
      const a = api();
      if (!a || typeof a.fileWriteText !== "function") throw new Error(t("主进程没有写文件的接口"));
      try {
        if (typeof a.fileMkdir === "function") await a.fileMkdir(joinP(abs, ".."));
      } catch (_) {}
      const r = await a.fileWriteText(abs, str(text));
      if (r && r.ok === false) throw new Error(str(r.error || t("写文件失败")));
      return r;
    }
    async function readJson(abs) {
      try {
        const s = (await readText(abs)).trim();
        return s ? JSON.parse(s) : null;
      } catch (_) {
        return null;
      }
    }
    function syncPath() {
      return joinP(RS().root, "sync.json");
    }
    function taskPath(rootDir) {
      return joinP(rootDir, "sync", "task.json");
    }
    function resultPath(rootDir) {
      return joinP(rootDir, "sync", "result.json");
    }
    function snapName(doc) {
      return hashString(normRel(doc)) + ".md";
    }
    function snapPath(doc) {
      return joinP(RS().root, "sync", "before", snapName(doc));
    }

    /* ── 文档集合：笔记（含 notes/ 子目录里的衍生物）+ 折叠 + 文献全文 ──
     * 扫的是「下游可能还留着旧字句的地方」，所以三类都要：衍生物在 notes/，
     * 参考内容在 literature/。缓存 20 秒：自动保存 900ms 一次，不能每次都把全文读一遍。 */
    const core = () => (ctx.C ? ctx.C() : typeof window !== "undefined" ? window.MTResearchCore : null);
    /* 衍生物关系在 frontmatter 里（parent / parents / derivedFrom + 父笔记反记 derives），
       与建图同一口径 —— 自己读 meta 会漏掉别名的几种写法。 */
    function parentsOf(meta) {
      const C = core();
      if (C && typeof C.readDeriveParents === "function") return C.readDeriveParents(meta || {});
      const v = meta && (meta.parents || meta.parent);
      return (Array.isArray(v) ? v : v ? [v] : []).map((x) => str(x));
    }
    function derivesOf(meta) {
      const v = meta && (meta.derives || meta.derive);
      return (Array.isArray(v) ? v : v ? [v] : []).map((x) => str(x));
    }
    function metaOf(md) {
      const C = core();
      if (!C || typeof C.parseNote !== "function") return {};
      try {
        return (C.parseNote({ path: "x.md", md: md }) || {}).meta || {};
      } catch (_) {
        return {};
      }
    }
    async function collectDocs(force) {
      const st = RS();
      if (!st.root) return [];
      if (!force && SY.docsCache && Date.now() - SY.docsAt < 20000) return SY.docsCache;
      const out = [];
      const push = (d) => {
        const p = normRel(d.path);
        if (!p || out.some((x) => normRel(x.path) === p)) return;
        out.push(d);
      };
      for (const n of st.notes || [])
        push({
          path: n.path,
          title: n.title,
          md: n.md,
          parents: parentsOf(n.meta),
          derives: derivesOf(n.meta),
        });
      for (const f of st.folds || []) push({ path: f.path, title: f.title, md: f.md });
      const a = api();
      const listDir = async (rel) => {
        try {
          const r = await a.fileReadDir(joinP(st.root, rel));
          return (r && r.entries) || [];
        } catch (_) {
          return [];
        }
      };
      /* notes/ 子目录（衍生物常写在 notes/derived/ 之类）：只摊平一层，与建图口径一致 */
      for (const e of await listDir("notes")) {
        if (!e.isDir) continue;
        for (const f of await listDir("notes/" + e.name)) {
          if (f.isDir || !/\.md$/i.test(f.name)) continue;
          const rel = "notes/" + e.name + "/" + f.name;
          if (out.some((x) => normRel(x.path) === rel)) continue;
          const md = await readText(joinP(st.root, rel));
          const meta = metaOf(md);
          push({
            path: rel,
            title: f.name.replace(/\.md$/i, ""),
            md: md,
            parents: parentsOf(meta),
            derives: derivesOf(meta),
          });
        }
      }
      /* 参考内容：PDF 抽出的全文（literature/pdf）、来源摘录（literature/sources）、
         三层折叠（literature/folds）—— 三类都可能整段引用了上游那句话 */
      for (const rel of ["literature/pdf", "literature/sources", "literature/folds"]) {
        for (const f of await listDir(rel)) {
          if (f.isDir || !/\.md$/i.test(f.name)) continue;
          const p = rel + "/" + f.name;
          if (out.some((x) => normRel(x.path) === p)) continue;
          push({ path: p, title: f.name.replace(/\.md$/i, ""), md: await readText(joinP(st.root, p)) });
        }
      }
      SY.docsCache = out;
      SY.docsAt = Date.now();
      return out;
    }

    /* ── 清单读写 ── */
    function normalizeItems(list) {
      const out = [];
      for (const raw of Array.isArray(list) ? list : []) {
        const it = raw || {};
        if (!it.id || !it.doc) continue;
        out.push(
          Object.assign({}, it, {
            status: ["pending", "running", "done", "failed"].indexOf(it.status) >= 0 ? it.status : "pending",
            checked: it.checked !== false,
            error: str(it.error),
          }),
        );
      }
      return out;
    }
    function trimItems() {
      if (SY.items.length <= MAX_ITEMS) return;
      const done = SY.items.filter((x) => x.status === "done").sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
      const drop = new Set(done.slice(0, Math.max(0, SY.items.length - MAX_ITEMS)).map((x) => x.id));
      if (drop.size) SY.items = SY.items.filter((x) => !drop.has(x.id));
    }
    async function persist() {
      const st = RS();
      if (!st.root) return;
      trimItems();
      try {
        await writeText(syncPath(), JSON.stringify({ ver: 1, updatedAt: Date.now(), items: SY.items }, null, 2));
      } catch (_) {}
    }
    function ensureLoaded() {
      const st = RS();
      if (!st.root) return Promise.resolve(SY.items);
      if (SY.root !== st.root) {
        SY.root = st.root;
        SY.items = [];
        SY.docsCache = null;
        SY.docsAt = 0;
        SY.loaded = false;
        SY.loading = null;
      }
      if (SY.loaded) return Promise.resolve(SY.items);
      if (SY.loading) return SY.loading;
      SY.loading = readJson(syncPath())
        .then((m) => {
          SY.items = normalizeItems((m && m.items) || []);
          SY.loaded = true;
          SY.loading = null;
          return SY.items;
        })
        .catch(() => {
          SY.loaded = true;
          SY.loading = null;
          return SY.items;
        });
      return SY.loading;
    }

    /* ── 保存后的扫描（应用层在 logChange 末尾调；这里再防抖一次）── */
    function afterSave(kind, rel, before, after) {
      const st = RS();
      if (!st.root || !rel) return;
      if (!/\.md$/i.test(rel)) return; /* 只记文本；library.json / pdf 二进制不扫 */
      if (str(before) === str(after)) return;
      SY.pending.set(normRel(rel), { rel: normRel(rel), before: str(before), after: str(after) });
      clearTimeout(SY.saveTimer);
      SY.saveTimer = setTimeout(() => {
        const batch = [...SY.pending.values()];
        SY.pending.clear();
        flush(batch).catch(() => {});
      }, 700);
    }
    async function flush(batch) {
      const st = RS();
      if (!st.root || !batch.length) return;
      await ensureLoaded();
      const docs = await collectDocs();
      for (const b of batch) {
        const hits = scan({ from: b.rel, before: b.before, after: b.after, docs });
        mergeHits(b.rel, hits, docs);
      }
      await persist();
      repaint();
      if (SY.panel) paint();
    }
    function mergeHits(from, hits, docs) {
      const seen = new Set();
      for (const h of hits) {
        seen.add(h.id);
        const old = SY.items.find((x) => x.id === h.id);
        if (old) {
          /* 同步过的就不再冒出来 —— 除非下游那一段又变回旧说法（说明它这次要重新同步） */
          if (old.status === "done" && str(old.oldText) === h.oldText) continue;
          old.oldText = h.oldText;
          old.newText = h.newText;
          old.change = h.change;
          old.diff = h.diff;
          old.ratio = h.ratio;
          old.kind = h.kind;
          old.ts = Date.now();
          old.status = "pending";
          old.error = "";
          old.checked = true;
        } else {
          SY.items.unshift(Object.assign({ status: "pending", checked: true }, h));
        }
      }
      /* 上游又改回去 / 下游已经被人手动改好的：撤掉这条待同步，别让人再点一遍 */
      const byDoc = new Map(docs.map((d) => [normRel(d.path), d.md]));
      SY.items = SY.items.filter((x) => {
        if (x.from !== from || x.status !== "pending" || seen.has(x.id)) return true;
        const md = byDoc.get(normRel(x.doc));
        if (md == null) return true;
        return stillStale(md, x);
      });
    }

    /* ── 统计 / 顶栏 chip ── */
    function stats() {
      const out = { total: 0, pending: 0, running: 0, failed: 0, done: 0, docs: new Set() };
      for (const it of SY.items) {
        const s = it.status || "pending";
        if (s === "done") {
          out.done++;
          continue;
        }
        out.total++;
        out[s] = (out[s] || 0) + 1;
        out.docs.add(it.doc);
      }
      out.docCount = out.docs.size;
      return out;
    }
    function chipInto(top) {
      if (!top) return null;
      const st = RS();
      if (!st.root) return null;
      if (!SY.loaded && !SY.loading) ensureLoaded().then(() => repaint());
      const s = stats();
      if (!s.total) return null;
      const label = t("同步下游 · ") + s.total + (s.running ? " …" : "");
      const b = el("button", "rs-chip rs-chip-sync" + (s.failed ? " bad" : " on"), label);
      b.title =
        t("上游改动命中了 ") +
        s.docCount +
        t(" 篇下游文档的 ") +
        s.total +
        t(" 处") +
        (s.running ? " · " + t("同步中 ") + s.running : "") +
        (s.failed ? " · " + t("失败 ") + s.failed : "");
      b.onclick = (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (SY.panel) closePanel();
        else openPanel(b);
      };
      top.appendChild(b);
      return b;
    }
    function repaint() {
      if (ctx.repaint) ctx.repaint();
    }

    /* ── 勾选弹层（沿用 .rs-ask 那套浮窗样式）── */
    function closePanel() {
      if (SY.onKey && typeof document !== "undefined") document.removeEventListener("keydown", SY.onKey);
      SY.onKey = null;
      if (SY.panel && SY.panel.parentNode) SY.panel.parentNode.removeChild(SY.panel);
      SY.panel = null;
    }
    function openPanel(anchor) {
      ensureLoaded().then(() => {
        if (!SY.panel) paint();
      });
      closePanel();
      const box = el("div", "rs-ask wide rs-sync");
      box.appendChild(el("div", "rs-sync-head"));
      const list = el("div", "rs-sync-list");
      box.appendChild(list);
      box.appendChild(el("div", "rs-sync-actions"));
      if (typeof document !== "undefined") {
        document.body.appendChild(box);
        const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        const width = 580;
        const left = rect ? Math.max(8, Math.min(rect.left, (window.innerWidth || 1200) - width - 8)) : 24;
        const top = rect ? rect.bottom + 6 : 120;
        box.style.left = left + "px";
        box.style.top = Math.max(8, Math.min(top, (window.innerHeight || 800) - 160)) + "px";
        box.style.right = "auto";
        SY.onKey = (e) => {
          if (e && e.key === "Escape") closePanel();
        };
        document.addEventListener("keydown", SY.onKey);
      }
      SY.panel = box;
      paint();
    }
    function paint() {
      const box = SY.panel;
      if (!box) return;
      const s = stats();
      const head = box.querySelector(".rs-sync-head");
      if (head) {
        head.innerHTML = "";
        head.appendChild(el("b", null, t("同步下游")));
        head.appendChild(
          el(
            "span",
            "rs-sync-sub",
            t("受影响 ") + s.total + t(" 处 · ") + s.docCount + t(" 篇") + (s.done ? " · " + t("已同步 ") + s.done : ""),
          ),
        );
        const x = el("button", "rs-ask-x", "✕");
        x.title = t("关闭");
        x.onclick = () => closePanel();
        head.appendChild(x);
      }
      const list = box.querySelector(".rs-sync-list");
      if (list) {
        list.innerHTML = "";
        const items = SY.items
          .slice()
          .sort((a, b) => str(a.doc).localeCompare(str(b.doc)) || (a.line || 0) - (b.line || 0));
        if (!items.length)
          list.appendChild(
            el("div", "rs-lit-empty", t("没有待同步的项：改了上游笔记、且下游还留着那段旧字句时，这里才会冒出来。")),
          );
        const groups = new Map();
        for (const it of items) {
          if (!groups.has(it.doc)) groups.set(it.doc, []);
          groups.get(it.doc).push(it);
        }
        for (const [doc, arr] of groups) {
          const gh = el("div", "rs-sync-doc");
          gh.appendChild(el("span", "rs-sync-path", doc));
          const kinds = {};
          for (const it of arr) kinds[it.kind] = 1;
          for (const k of Object.keys(kinds))
            gh.appendChild(el("span", "rs-sync-tag", k === "derived" ? t("衍生物") : k === "reference" ? t("参考内容") : t("引用")));
          gh.appendChild(el("span", "rs-sync-tag ghost", String(arr.length) + t(" 处")));
          list.appendChild(gh);
          for (const it of arr) list.appendChild(rowOf(it));
        }
      }
      const acts = box.querySelector(".rs-sync-actions");
      if (acts) {
        acts.innerHTML = "";
        const selectable = SY.items.filter((x) => x.status === "pending" || x.status === "failed");
        const checked = selectable.filter((x) => x.checked !== false);
        const all = el("label", "rs-sync-all");
        const allCb = el("input");
        allCb.type = "checkbox";
        allCb.checked = selectable.length > 0 && checked.length === selectable.length;
        allCb.disabled = !selectable.length || SY.busy;
        allCb.onchange = () => {
          for (const it of selectable) it.checked = allCb.checked;
          paint();
        };
        all.appendChild(allCb);
        all.appendChild(el("span", null, t("全选")));
        acts.appendChild(all);
        acts.appendChild(el("span", "rs-grow"));
        if (s.running)
          acts.appendChild(el("span", "rs-sync-state", t("同步中 ") + s.running + t(" 项…")));
        else if (s.failed) acts.appendChild(el("span", "rs-sync-state bad", t("失败 ") + s.failed + t(" 项（原因见上）")));
        const go = el("button", "rs-btn primary", s.running ? t("同步中…") : t("同步勾选项"));
        go.disabled = !checked.length || SY.busy || !!s.running;
        go.title = t("把勾选的每一项交给 subagent 原地改写（不另存 v2），每项各记一条改动");
        go.onclick = () => runSync();
        acts.appendChild(go);
      }
    }
    function rowOf(it) {
      const row = el("label", "rs-sync-row " + (it.status || "pending"));
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = it.checked !== false && it.status !== "done";
      cb.disabled = it.status === "done" || it.status === "running" || SY.busy;
      cb.onchange = () => {
        it.checked = cb.checked;
        paint();
      };
      row.appendChild(cb);
      const main = el("div", "rs-sync-main");
      main.appendChild(
        el("div", "rs-sync-para", t("第 ") + (it.line || "?") + t(" 行 · ") + clipText(it.oldText, 90)),
      );
      if (it.change === "removed") {
        main.appendChild(el("div", "rs-sync-diff", t("上游这段已删除 → 下游这一处跟着删掉或改写")));
      } else {
        const d = it.diff || {};
        const line = el("div", "rs-sync-diff");
        line.appendChild(el("span", "rs-sync-old", "旧「" + clipText(d.oldMid || it.oldText, 40) + "」"));
        line.appendChild(el("span", "rs-sync-arrow", " → "));
        line.appendChild(el("span", "rs-sync-new", "新「" + clipText(d.newMid || it.newText, 40) + "」"));
        main.appendChild(line);
      }
      if (it.status === "failed")
        main.appendChild(el("div", "rs-sync-state bad", t("✗ 失败：") + (it.error || t("没有给出原因"))));
      else if (it.status === "running") main.appendChild(el("div", "rs-sync-state", t("同步中… subagent 正在原地改写")));
      else if (it.status === "done")
        main.appendChild(el("div", "rs-sync-state ok", t("✓ 已同步") + (it.note ? " · " + it.note : "")));
      row.appendChild(main);
      return row;
    }

    /* ── 派活：task.json（只读清单）+ result.json（agent 回写）+ 一条专用会话 ── */
    function findSession(rootDir) {
      const S = ctx.sessions || {};
      if (typeof S.list !== "function") return null;
      const dir = str(rootDir).replace(/[\\/]+$/, "");
      const list = S.list() || [];
      for (const s of list) {
        if (!s || s.archived) continue;
        if (str(s.workspace).replace(/[\\/]+$/, "") !== dir) continue;
        if (str(s.title).indexOf(t("同步下游")) !== 0) continue;
        return s;
      }
      return null;
    }
    function taskPrompt(taskPathAbs, resultPathAbs, rootDir) {
      return [
        t("你在做「同步下游」：上游笔记改了，下游的衍生物 / 参考内容里还留着旧说法，要逐项改到与上游一致。"),
        "",
        "- 清单（只读）：`" + taskPathAbs + "`",
        "- 结果（由你写）：`" + resultPathAbs + "`",
        "- 工作目录：`" + str(rootDir).replace(/\\/g, "/") + "`",
        "",
        t("清单里每一项："),
        "- `doc`：要改的文档（相对工作目录，直接原地改写这个文件）",
        "- `line` / `oldText`：它现在那段旧文字（行号可能偏几行，按文字找）",
        "- `newText`：上游改动后的新文字（是依据，不是要照抄的原文）",
        "- `from`：上游笔记（**只读，一个字都不许动**）",
        "",
        t("逐项做："),
        "1. " + t("读 `doc`，定位 `oldText` 那一段。"),
        "2. " +
          t("按 `newText` 的信息**原地改写这一段**：保持这篇文档自己的语气、结构与篇幅，不照抄整段上游原文；不新建文件、不另存 v2、不动这篇里的其它段落。"),
        "3. " + t("每一项都派一个 subagent 去做（它只改这一处，改完回报你一句话）；你只负责派活与汇总。"),
        "4. " +
          t("这一项做完：把 {id, status:\"done\", note:\"一句话改了什么\"} 追加进 result.json 的 items；失败就写 {id, status:\"failed\", error:\"一句话原因\"}。每做完一项立刻写一次 result.json（界面靠它显示进度）。"),
        "",
        t("全部做完回一句总结：改了几项、失败几项。"),
      ].join("\n");
    }
    async function dispatch(rootDir) {
      const S = ctx.sessions || {};
      let st = findSession(rootDir);
      if (!st) {
        st = S.create ? S.create() : null;
        if (!st) throw new Error(t("新建会话失败"));
        st.title = t("同步下游") + " · " + str((RS().meta && RS().meta.title) || "");
        st.titleLocked = true;
        st.titleAuto = false;
        st.canvasWfId = str(RS().wfId) || st.canvasWfId;
        try {
          if (S.setWorkspace) await S.setWorkspace(st, rootDir);
        } catch (_) {}
        try {
          if (S.persist) await S.persist();
          if (S.sidebar) await S.sidebar();
        } catch (_) {}
      }
      const msg = taskPrompt(taskPath(rootDir), resultPath(rootDir), rootDir);
      S.send(msg, st.id);
      return st.id;
    }

    async function runSync() {
      if (SY.busy) return;
      const st = RS();
      const pick = SY.items.filter((x) => x.checked !== false && (x.status === "pending" || x.status === "failed"));
      if (!pick.length) {
        toast(t("没有勾选可同步的项"), "warn");
        return;
      }
      if (!st.root) {
        toast(t("研究目录还没就绪"), "err");
        return;
      }
      SY.busy = true;
      paint();
      try {
        /* 0 号闸（金色版本优先）：同步下游是**原地改写**，落笔前逐篇过一遍写入口的闸。
           任何一篇被拒就整轮不派 —— 快照 / 派活清单 / 结果文件都不写，正文一个字不动，
           勾选项与状态也原样留着（不留 failed 假记录，用户改回那一版还能再按一次）。 */
        const gateDocs = [];
        for (const it of pick) if (gateDocs.indexOf(it.doc) < 0) gateDocs.push(it.doc);
        if (typeof ctx.gate === "function") {
          for (const doc of gateDocs) {
            if (await ctx.gate(doc)) continue;
            toast(t("已取消：改动应集中在被改过的那一版，本轮同步没有下发"), "warn");
            return;
          }
        }
        /* 1. 每篇文档先拍一张同步前快照：changes.jsonl 的 before 用它，撤销才是整篇级的 */
        SY.img = new Map();
        const docs = [];
        for (const it of pick) if (docs.indexOf(it.doc) < 0) docs.push(it.doc);
        for (const doc of docs) {
          const md = await readText(joinP(st.root, doc));
          await writeText(snapPath(doc), md);
          SY.img.set(doc, md);
        }
        /* 2. 派活清单 + 空结果文件（agent 只写 result.json） */
        const task = {
          ver: 1,
          createdAt: Date.now(),
          root: str(st.root).replace(/\\/g, "/"),
          items: pick.map((it) => ({
            id: it.id,
            from: it.from,
            doc: it.doc,
            title: it.title,
            line: it.line,
            oldText: it.oldText,
            newText: it.newText,
            change: it.change,
            diff: it.diff,
          })),
        };
        await writeText(taskPath(st.root), JSON.stringify(task, null, 2));
        await writeText(resultPath(st.root), JSON.stringify({ ver: 1, updatedAt: Date.now(), items: [] }, null, 2));
        for (const it of pick) {
          it.status = "running";
          it.error = "";
          it.checked = true;
          it.startedAt = Date.now();
          delete it.note;
        }
        await persist();
        paint();
        SY.session = await dispatch(st.root);
        startPoll();
      } catch (e) {
        for (const it of pick) {
          it.status = "failed";
          it.error = t("派活失败：") + str((e && e.message) || e);
        }
        await persist();
        paint();
        repaint();
        toast(t("派活失败：") + str((e && e.message) || e), "err");
      } finally {
        SY.busy = false;
        paint();
      }
    }

    /* ── 轮询 result.json → 合并状态 → 记 changes.jsonl → 刷新树与图谱统计 ── */
    function startPoll() {
      stopPoll();
      SY.timer = setInterval(() => {
        tick().catch(() => {});
      }, POLL_MS);
      tick().catch(() => {});
    }
    function stopPoll() {
      if (SY.timer) {
        clearInterval(SY.timer);
        SY.timer = null;
      }
    }
    async function markDone(it, note) {
      const st = RS();
      it.status = "done";
      it.doneAt = Date.now();
      it.note = str(note);
      it.checked = false;
      try {
        const after = await readText(joinP(st.root, it.doc));
        const before = SY.img.has(it.doc) ? SY.img.get(it.doc) : await readText(snapPath(it.doc));
        if (after && after !== before) {
          if (ctx.saveChange) await ctx.saveChange(t("同步下游"), it.doc, before, after);
          it.changesLogged = true;
        } else {
          it.note = it.note || t("内容已一致，无需改动");
        }
        SY.img.set(it.doc, after);
      } catch (e) {
        it.status = "failed";
        it.error = t("记改动失败：") + str((e && e.message) || e);
      }
    }
    async function tick() {
      const st = RS();
      if (!st.root) {
        stopPoll();
        return;
      }
      const running = SY.items.filter((x) => x.status === "running");
      if (!running.length) {
        stopPoll();
        return;
      }
      const res = await readJson(resultPath(st.root));
      const rows = (res && res.items) || [];
      let changed = false;
      let answered = 0;
      for (const r of rows) {
        const it = SY.items.find((x) => x.id === r.id && x.status === "running");
        if (!it) continue;
        answered++;
        if (r.status === "done") {
          await markDone(it, r.note);
          changed = true;
        } else if (r.status === "failed") {
          it.status = "failed";
          it.error = str(r.error) || t("同步失败（没有给出原因）");
          it.checked = false;
          changed = true;
        }
      }
      /* 一个字都没回写、又跑太久：标失败，别让它永远挂着「同步中」 */
      if (!answered) {
        const now = Date.now();
        for (const it of running) {
          if (now - (it.startedAt || now) > MAX_WAIT_MS) {
            it.status = "failed";
            it.error = t("超时：会话没有回写结果");
            it.checked = false;
            changed = true;
          }
        }
      }
      if (changed) {
        await persist();
        paint();
        repaint();
      }
      if (!SY.items.some((x) => x.status === "running")) {
        stopPoll();
        await finishRun();
      }
    }
    async function finishRun() {
      const s = stats();
      try {
        if (ctx.refresh) await ctx.refresh();
      } catch (_) {}
      SY.docsCache = null;
      SY.docsAt = 0;
      repaint();
      if (SY.panel) paint();
      if (s.failed) toast(t("同步完成，失败 ") + s.failed + t(" 项"), "warn");
      else toast(t("同步完成：") + s.done + t(" 项已同步"));
    }

    return {
      chipInto,
      afterSave,
      ensureLoaded,
      openPanel,
      closePanel,
      stats,
      runSync,
      /* 给验证 / 别处复用的纯逻辑 */
      scan,
      paragraphs,
      diffBrief,
      norm,
      NGRAM,
      SEED,
      state: SY,
    };
  }

  return {
    create,
    scan,
    paragraphPairs,
    paragraphs,
    diffBrief,
    stillStale,
    downstreamSet,
    norm,
    NGRAM,
    SEED,
    MIN_PARA,
  };
});

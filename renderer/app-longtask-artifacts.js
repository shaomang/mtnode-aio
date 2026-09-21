/* renderer/app-longtask-artifacts.js —— 长周期任务「产物上画布」（自包含新模块，挂 window.LTART）
 *
 * 需求：长任务在每个环节完成时**清点本次的产物**，把其中**用户该读 / 该收的关键文件**
 * **逐个摆出来**并排好版 —— 用户不用去翻条带或文件夹，画布上直接看到这次跑出了什么；
 * 中间件与调试件不占画布（口径见下面 ②，本轮需求）。摆上来的东西各有形态：图片出缩略图、
 * 文本可读摘要、其它类型给路径 + 打开入口。
 * 落点（本轮改动）：**本环节的超级节点子壳内**（长任务壳 · app-longtask-shell.js
 * 的 artifactsParentOf 决定 parentSuperId 与子壳内坐标）；壳不可用 / 壳模块缺席时
 * 回落主画布层（旧行为），产出回流绝不因此断链。
 *
 * 只做三件事，不碰状态机口径、不建自己的存储：
 *   ① 清点 + 挑选：从「本环节自己的状态命名空间」里取此刻真的读得到的绝对路径（父命名空间
 *      里继承来的上游路径不算本环节产物 —— 否则每个下游环节都会把上游的图再摆一遍），
 *      再按**「关键文件」口径**筛一道（见下面 ②）：只把用户该读 / 该收的东西摆上画布；
 *   ② 放置：一件产物 = 一颗 `ltart` 节点（系统专属 kind，见 app.js 的 NODE_DEFAULTS.ltart
 *      与 app-canvas.js 的 buildLtartBody），按 (任务 uid, 环节路径, 文件路径) 认人 ——
 *      重跑 / 回跳复用同一颗，不会每跑一轮就堆一片；节点由本模块直接建（不弹 toast、
 *      不进撤销栈：与产出节点同一套系统建法）；
 *   ③ 排版：新节点摆在同环节「产出节点」右侧的空位网格里（逐格找不压住既有节点的位置），
 *      已有节点不挪（用户拖动过就尊重用户的摆法）。
 *
 * 加载顺序：必须在 app-longtask.js 之后（用到它的 ltArr / ltOutputFileStat /
 * ltOutputCanvasNodeOf 等）；app-longtask.js 的 ltOutputPublish 末尾按全局判空调用本模块，
 * 所以两边谁先加载都不会抛（缺料时降级成「不摆」）。所有外部调用都带 typeof 判空。
 */
const LT_ART_MAX = 32; /* 单次清点最多摆几件（map 展开很多实例时不把画布铺满） */
const LT_ART_W = 260;
const LT_ART_H = 210;
const LT_ART_GAP = 28;
const LT_ART_COLS = 3;

/* ── 与引擎同源的兜底取值（外部全局缺了也不抛）────────────────────── */
function ltArtArr(v) {
  return typeof ltArr === "function" ? ltArr(v) : Array.isArray(v) ? v : [];
}
function ltArtObj(v) {
  return v && typeof v === "object" ? v : {};
}
function ltArtT(s) {
  return typeof ltT === "function" ? ltT(s) : String(s == null ? "" : s);
}
function ltArtNow() {
  return typeof ltNow === "function" ? ltNow() : Date.now();
}

/* ── ① 分类：什么产物适合摆上画布、按什么形态渲染 ────────────────────
 * 常见媒体与文本 / 文档各有预览形态；其余一律当「文件」摆（有路径 + 打开入口，
 * 总比让用户不知道跑出了什么强）。 */
const LT_ART_EXT = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"],
  video: ["mp4", "mov", "webm", "mkv", "avi", "m4v"],
  audio: ["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"],
  text: ["md", "markdown", "txt", "log", "json", "csv", "tsv", "yaml", "yml", "html", "htm", "xml", "srt", "vtt"],
};
function ltArtExtOf(p) {
  const m = String(p || "").match(/\.([A-Za-z0-9]{1,8})(?:[?#].*)?$/);
  return m ? m[1].toLowerCase() : "";
}
function ltArtTypeOf(p) {
  const ext = ltArtExtOf(p);
  for (const k of Object.keys(LT_ART_EXT)) if (LT_ART_EXT[k].indexOf(ext) >= 0) return k;
  return "file";
}
function ltArtTypeName(type) {
  if (type === "image") return ltArtT("图像");
  if (type === "video") return ltArtT("视频");
  if (type === "audio") return ltArtT("音频");
  if (type === "text") return ltArtT("文本");
  return ltArtT("文件");
}
function ltArtFileName(p) {
  const s = String(p || "");
  return s.split(/[\\/]/).pop() || s;
}

/* ── ② 挑选：哪些文件**值得摆上画布**（本轮需求）────────────────────────
 * 口径：长任务一轮跑下来会写很多东西 —— 中间件（分镜 JSON、抽帧图、conll 之类）、
 * 调试件、缓存、依赖锁…… 全摆上画布只会把用户的画布铺满，让他找不到真正要看的那几件。
 * 画布是「给人看结果」的地方：只摆**用户该读 / 该收的关键文件**，其余留在工作目录、
 * 需要时去产出节点或文件夹里找（产出节点的文件引用清单一件不少，绝不丢落盘结果）。
 *
 * 摆：（一）报告与文档 —— md / pdf / txt / html / doc(x) / ppt(x) / 字幕；
 *     （二）数据表 —— csv / tsv / xlsx(x)（交付给用户看的表）；
 *     （三）成品图 —— png / jpg / webp…（画布上就是缩略图，看一眼就知道成片对不对）。
 * 不摆：视频 / 音频（不是「读」的东西，画布上只多一堆它自己的播放器）、日志与配置文件、
 *       中间件与依赖锁、源码 / 脚本 / 归档 / 数据库 / 可执行文件。
 * 注意：只影响**自动摆放**（ltArtPublish / 旧 checkpoint 补摆）——交付环节用户亲手确认过的
 * 交付件另走一条（app-longtask.js 直接调 ltArtPublish，交上来的就是他要的东西）。 */
const LT_ART_DOC_EXT = [
  "md", "markdown", "mdx", "pdf", "txt", "text", "rtf", "html", "htm", "doc", "docx", "odt", "ppt", "pptx", "srt", "vtt",
];
const LT_ART_DATA_EXT = ["csv", "tsv", "xlsx", "xls", "ods"];
const LT_ART_MEDIA_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"];
const LT_ART_DROP_EXT = [
  "log", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "conf", "cfg", "bak", "tmp", "cache", "part", "lock",
  "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "ps1", "bat", "cmd", "sh", "rb", "go", "rs", "java", "c", "cc", "cpp", "h", "hpp", "cs", "sql",
  "db", "sqlite", "sqlite3", "zip", "rar", "7z", "tar", "gz", "exe", "dll", "msi", "bin", "iso", "apk", "whl", "onnx", "pt", "pth", "safetensors", "gguf",
];
const LT_ART_DOC_NAME_RE = /(?:^|[\\/])(readme|report|summary|摘要|报告|说明|清单|总结|spec|设计|导览|指南)(?:\.[a-z0-9]{1,8})?$/i;
/* 一眼判类：doc（报告文档）/ data（数据表）/ image（成品图）/ null（不摆）。
   不写 LT_ART_EXT 取反那一档（zip / exe 之类落 "file"）—— 正是本轮要清掉的噪声。 */
function ltArtPickClassOf(p) {
  const ext = ltArtExtOf(p);
  if (LT_ART_DROP_EXT.indexOf(ext) >= 0) return null;
  if (LT_ART_DOC_EXT.indexOf(ext) >= 0) return "doc";
  if (LT_ART_DATA_EXT.indexOf(ext) >= 0) return "data";
  if (LT_ART_MEDIA_EXT.indexOf(ext) >= 0) return "image";
  if (!ext) return LT_ART_DOC_NAME_RE.test(String(p || "")) ? "doc" : null;
  return null;
}
/* 按类别排序后的「关键文件」清单（顺序 = 摆上画布的顺序）：报告文档 → 数据表 → 成品图。
   limit 缺省 = LT_ART_MAX（与产物节点上限同源，别把画布铺满）。 */
function ltArtPick(paths, limit) {
  const cap = limit == null ? LT_ART_MAX : Number(limit) || 0;
  if (cap <= 0) return [];
  const seen = new Set();
  const out = [];
  for (const p of ltArtArr(paths)) {
    const s = String(p || "");
    if (!s || seen.has(s)) continue;
    seen.add(s);
    const cls = ltArtPickClassOf(s);
    if (!cls) continue;
    out.push({ path: s, cls: cls, w: cls === "doc" ? 0 : cls === "data" ? 1 : 2 });
  }
  out.sort((a, b) => a.w - b.w);
  return out.slice(0, cap).map((x) => x.path);
}

/* ── 本轮 run 的「所属画布」（本轮需求：长任务不许把产物摆到错误的画布）──────────
   引擎侧一律按 run.wfId 解析（app-longtask.js ltRunCanvas：前台 → 内存袋；已删 / 未打开
   一律不给，**绝不退回前台画布**）；run 没绑画布的老 checkpoint 与裸调用退回 S.wf。 */
function ltArtWfOf(run) {
  if (typeof ltRunCanvas === "function") {
    const wf = ltRunCanvas(run);
    if (wf) return wf;
    if (run && run.wfId) return null;
  }
  return typeof S !== "undefined" && S ? S.wf : null;
}
/* 同步段：把 S.wf 临时换成归属画布（段内不许 await）——建节点 / 去重标题 / 宿主判定
   都要按它解析；退出即还原，用户屏幕不受影响（重绘 / 落盘见 ltArtAfterWrite）。 */
function ltArtSync(wf, fn) {
  if (typeof ltSyncCanvas === "function") return ltSyncCanvas(wf, fn);
  const prev = typeof S !== "undefined" && S ? S.wf : null;
  const has = typeof S !== "undefined" && !!S;
  if (has) S.wf = wf;
  try {
    return fn();
  } finally {
    if (has) S.wf = prev;
  }
}
/* 收尾分流：改的是用户看着的那张才重绘；后台那张按对象自己的 id 落盘 */
function ltArtAfterWrite(wf) {
  if (typeof ltAfterCanvasWrite === "function") return ltAfterCanvasWrite(wf);
  try {
    if (typeof renderCanvas === "function") renderCanvas();
    if (typeof scheduleSave === "function") scheduleSave(true);
  } catch (_) {}
}

/* ── ④ 认人 / 建法（系统专属 kind ltart · 与产出节点同一套）────────── */
function ltArtNodeOf(taskUid, path, file, wfIn) {
  const wf = wfIn || (typeof S !== "undefined" ? S.wf : null);
  if (!wf) return null;
  const t = String(taskUid || "");
  const p = String(path || "");
  const f = String(file || "");
  if (!t || !p || !f) return null;
  return (
    ltArtArr(wf.nodes).find(
      (n) =>
        n &&
        n.kind === "ltart" &&
        String(n.ltTaskUid || "") === t &&
        String(n.ltPath || "") === p &&
        String(n.ltFile || "") === f,
    ) || null
  );
}
function ltArtTitleOf(file, type) {
  return ltArtT("产物") + " · " + ltArtTypeName(type) + " · " + ltArtFileName(file);
}
/* 直接建节点（不走 addNode）：不弹「已添加节点」toast、不进撤销栈、不改当前选中；
   产出节点 / 交付节点同属系统建，这里只是把同一口径用在产物上。
   落点（本轮改动）：优先落进**本环节的超级节点子壳**（app-longtask-shell.js 的
   artifactsParentOf），壳不可用 / 模块缺席时回落主画布层（旧行为）。 */
function ltArtCreateNode(run, path, art, pos, wfIn) {
  if (typeof makeNode !== "function") return null;
  const wf = wfIn || ltArtWfOf(run);
  if (!wf) return null;
  const node = makeNode("ltart", pos.x, pos.y);
  if (!node) return null;
  /* 归属：先写身份，再让壳模块改写落点（parentSuperId + 子壳内坐标） */
  node.parentSuperId = "";
  node.parentTaskId = "";
  node.ltTaskUid = String((run && run.taskId) || "");
  node.ltRunId = String((run && run.runId) || "");
  node.ltPath = String(path || "");
  node.ltFile = String(art.file || "");
  node.ltType = String(art.type || "file");
  node.ltName = ltArtFileName(art.file);
  node.ltSize = Number(art.size) || 0;
  node.ltMtime = Number(art.mtime) || 0;
  node.ltAt = ltArtNow();
  const want = ltArtTitleOf(art.file, art.type);
  node.title = typeof uniqueNodeTitle === "function" ? uniqueNodeTitle(want) : want;
  node.__ltSystem = true;
  if (!Array.isArray(wf.nodes)) wf.nodes = [];
  wf.nodes.push(node);
  if (typeof ltShellArtifactsParent === "function") {
    try {
      ltShellArtifactsParent(run, path, node);
    } catch (_) {}
  }
  return node;
}

/* ── ⑤ 排版：同环节「产出节点」右侧的空位网格 ────────────────────────
 * 逐格试位置，与既有节点（含本轮刚摆的）不重叠才用；已有产物节点一律不挪。 */
function ltArtRects(wfIn) {
  const wf = wfIn || (typeof S !== "undefined" ? S.wf : null);
  if (!wf) return [];
  /* 只算**主画布层**节点：超级节点壳内的子节点用的是壳内坐标系，混进来当世界坐标算会得出
     假冲突（把回落主画布层的产物推到很远的地方）。 */
  return ltArtArr(wf.nodes)
    .filter((n) => !String((n && n.parentSuperId) || "").trim())
    .map((n) => ({
      id: String((n && n.id) || ""),
      x: Number(n && n.x) || 0,
      y: Number(n && n.y) || 0,
      w: Number(n && n.w) || 200,
      h: Number(n && n.h) || 160,
    }));
}
function ltArtHit(r, q, pad) {
  const p = pad == null ? 12 : pad;
  return !(r.x + r.w + p <= q.x || q.x + q.w + p <= r.x || r.y + r.h + p <= q.y || q.y + q.h + p <= r.y);
}
function ltArtAnchor(run, path, wfIn) {
  const wf = wfIn || ltArtWfOf(run);
  const out =
    typeof ltOutputCanvasNodeOf === "function" ? ltOutputCanvasNodeOf(run, path, wf) : null;
  if (out) return { x: (Number(out.x) || 0) + (Number(out.w) || LT_ART_W) + 56, y: Number(out.y) || 0 };
  /* 没有产出节点（比如人工交付环节）：退回视口右上角，按已有产物节点往下错开 */
  const cam = (wf && wf.cam) || { x: 0, y: 0, k: 1 };
  const k = Number(cam.k) || 1;
  const vw = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1280;
  return { x: (vw - LT_ART_W - 80 - (Number(cam.x) || 0)) / k, y: (150 - (Number(cam.y) || 0)) / k };
}
function ltArtPlace(run, path, rects, wfIn) {
  const anchor = ltArtAnchor(run, path, wfIn);
  for (let i = 0; i < 400; i++) {
    const col = i % LT_ART_COLS;
    const row = Math.floor(i / LT_ART_COLS);
    const r = {
      x: anchor.x + col * (LT_ART_W + LT_ART_GAP),
      y: anchor.y + row * (LT_ART_H + LT_ART_GAP),
      w: LT_ART_W,
      h: LT_ART_H,
    };
    if (!rects.some((q) => ltArtHit(r, q))) {
      rects.push(r);
      return { x: Math.round(r.x), y: Math.round(r.y) };
    }
  }
  return { x: Math.round(anchor.x), y: Math.round(anchor.y) };
}

/* ── 清点本环节自己的产物 ────────────────────────────────────────────
 * 「自己的」= 写在本环节命名空间里的路径，且**不在父命名空间里**出现
 * （父空间里的都是上游环节交下来的输入，不该在下游再摆一遍）。
 * 相对路径按本运行的工作目录（run.ws）解析成绝对路径 —— Agent 回报的产物路径
 * 多数是工作区相对路径，只认绝对路径会把一整轮产物全部漏掉。
 * 只收此刻真的读得到的文件（读不到的登记上去只会变成一张死卡）。 */
function ltArtAbs(p, run) {
  let s = String(p == null ? "" : p).trim();
  if (!s) return "";
  if (/^[A-Za-z]:[\\/]/.test(s) || s.slice(0, 2) === "\\\\") return s.replace(/\//g, "\\");
  if (s.charAt(0) === "/" && s.charAt(1) !== "/") return s.replace(/\//g, "\\");
  const ws = String((run && run.ws) || "").trim();
  if (!ws) return "";
  return ws.replace(/[\\/]+$/, "") + "\\" + s.replace(/^[\\/]+/, "").replace(/\//g, "\\");
}
function ltArtOwnPaths(run, path, files) {
  const seen = new Set();
  const own = [];
  for (const f of ltArtArr(files)) {
    const p = typeof f === "string" ? f : String(ltArtObj(f).path || "");
    const s = ltArtAbs(p, run);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    own.push(s);
  }
  if (!own.length) return [];
  /* 父空间（继承来的输入）里出现过的路径剔除 —— 这里要的是**链上口径**（ltStateChain）：
     「父空间」= 祖先层，不是「整份共享状态」。用 ltStateFlat 会把本环节自己那一层
     （乃至别处同名路径）也算成继承，本环节刚写的产物会被当成别人的而不摆上画布。 */
  const inherited = new Set();
  const parentFlatOf = typeof ltStateChain === "function" ? ltStateChain : typeof ltStateFlat === "function" ? ltStateFlat : null;
  if (parentFlatOf && typeof ltPathParent === "function") {
    const parentFlat = parentFlatOf(run, ltPathParent(String(path || "")));
    for (const k of Object.keys(parentFlat || {})) {
      const v = parentFlat[k];
      if (typeof v === "string") inherited.add(ltArtAbs(v, run));
    }
  }
  return own.filter((p) => !inherited.has(p));
}

/* 落画布主入口（引擎在「刚写完的那一刻」调）：清点 → **挑关键件** → 逐个放置 / 更新 → 排版。
 * files 可给路径字符串数组或 [{ path }]；回 { ok, placed, updated, own, selected }
 * （own = 本环节清点出来的文件数 · selected = 其中按关键文件口径摆上画布的件数：
 *   两者不等是设计行为 —— 其余文件仍留在工作目录与产出节点的引用清单里，只是不占画布）。 */
async function ltArtPublish(run, path, files) {
  const out = { ok: false, placed: 0, updated: 0, own: 0, selected: 0 };
  if (!run || !path) return out;
  if (typeof makeNode !== "function") return out;
  /* 归属画布**先定死**（run.wfId；解析不到就不写，绝不落到用户此刻看着的那张图上）：
     用户中途切画布时，旧口径按 S.wf 找 / 建，产物会整批摆到别人的画布上。 */
  const wf = ltArtWfOf(run);
  if (!wf) return out;
  const own = ltArtOwnPaths(run, path, files);
  out.own = own.length;
  /* 本轮需求：只摆**用户该读 / 该收的关键文件**（报告文档 / 数据表 / 成品图），
     中间件、日志、依赖锁、音视频一律不占画布（挑选口径见上面 ④）。
     先挑后读：读文件指纹只为「要摆的那几件」付 IO，不再整轮扫一遍。 */
  const keys = ltArtPick(own);
  if (!keys.length) return out;
  /* 指纹：异步段只读文件、不碰画布 —— 画布对象全程显式带着走（不读 S.wf，切画布不串） */
  const arts = [];
  for (const p of keys) {
    const st = typeof ltOutputFileStat === "function" ? await ltOutputFileStat(p) : null;
    if (!st) continue; /* 读不到 = 此刻不算产物 */
    arts.push({ file: p, type: ltArtTypeOf(p), size: st.size, mtime: st.mtime });
  }
  if (!arts.length) return out;
  out.selected = arts.length;
  /* 建 / 改节点全部放进**同步段**：段内 S.wf = 归属画布（壳里的 makeNode 与标题去重、
     宿主判定都要按它解析），段内不许 await。 */
  ltArtSync(wf, () => {
    const rects = ltArtRects(wf);
    for (const art of arts) {
      let node = ltArtNodeOf(run.taskId, path, art.file, wf);
      if (node) {
        node.ltRunId = String(run.runId || "");
        node.ltType = art.type;
        node.ltName = ltArtFileName(art.file);
        node.ltSize = art.size;
        node.ltMtime = art.mtime;
        node.ltAt = ltArtNow();
        /* 已有节点也对齐落点：壳建起来了就搬进本环节子壳（壳缺席 / 被删时留在原处） */
        if (typeof ltShellArtifactsParent === "function") {
          try {
            ltShellArtifactsParent(run, path, node);
          } catch (_) {}
        }
        out.updated++;
        continue;
      }
      node = ltArtCreateNode(run, path, art, ltArtPlace(run, path, rects, wf), wf);
      if (node) out.placed++;
    }
  });
  if (out.placed || out.updated) {
    out.ok = true;
    /* 收尾分流：用户看着的那张才重绘；后台那张按对象自己的 id 落盘 */
    ltArtAfterWrite(wf);
  }
  return out;
}

window.LTART = {
  MAX: LT_ART_MAX,
  typeOf: ltArtTypeOf,
  typeName: ltArtTypeName,
  fileName: ltArtFileName,
  nodeOf: ltArtNodeOf,
  /* 清点与挑选分开导出：ownPaths = 本环节自己写出来的全部文件（原口径不动），
     pickKeyFiles = 其中值得摆上画布的**关键文件**（本轮需求），publish 走的就是它。 */
  ownPaths: ltArtOwnPaths,
  pickKeyFiles: ltArtPick,
  pickClassOf: ltArtPickClassOf,
  publish: ltArtPublish,
  /* 本轮需求：产物摆到哪张画布按 run.wfId 解析（解析不到不写），见 ltArtWfOf */
  wfOf: ltArtWfOf,
};

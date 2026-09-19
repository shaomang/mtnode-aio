"use strict";
/* ============================================================================
 * PDF → Markdown 渲染层解析编排（renderer/pdf-markdown.js）
 * ----------------------------------------------------------------------------
 * 唯一入口：window.openPdfParse(pdfPath, opts)
 *
 * 三档降级（不是静默空文本，每一步都给可读理由）：
 *   ① 结构化解析：主进程 pdf:probe / pdf:parse（pdf-doc.js 内核）抽取文本层 →
 *      标题 / 段落 / 列表 / 表格 / 公式占位，直接出 Markdown；
 *   ② 结构解析失败或没有文本层（扫描件 / 图片版 PDF）：逐页识图 —— 取页面图，
 *      用视觉模型 + dshRunTask({ images:[页图] }) 把每页转成 Markdown（公式走 LaTeX），
 *      结果按 <!-- page N --> 逐页拼接；
 *   ③ ①② 都不成：给一条可读错误（缺识图模型 / 缺页面渲染通道 / 加密 …）。
 *
 * 进度与取消：整轮走一次 openOverlay 进度窗（持久窗，不点外部关闭），逐页刷新进度，
 * 「取消」= 立刻 dshCancelActive(本轮的 runKey) 并在页间停下；已完成页保留。
 *
 * 消费方（都在调用期按 typeof 取本文件的全局函数）：
 *   · 拖入 PDF → 文本节点：app.js createNodesFromDroppedFiles（kind "text" + pdf）
 *   · 文本节点「导入」对话框：app.js importFileToText（filters 里有 PDF 一项）
 *   · 数据库「文件节点」行上的「解析为 Markdown」：app-db.js dbFileRowEl
 *       （原样保留该行的 binary 记录，只额外产出 Markdown 落盘并交给 Markdown 编辑器）
 *
 * 依赖（均为调用期取用的既有全局）：openOverlay / closeOverlay / toast / I18n /
 * dshRunTask / dshCancelActive / dbFirstVisionModel / resolveVisionInspectRoute /
 * openMdViewer / pushHistory / clearDownstream / scheduleSave / renderCanvas / S。
 * ==========================================================================*/

/* 逐页识图的页数上限：识图是「一页一次模型调用」，页面极多的扫描件先截断并如实告知 */
const PDF_VISION_MAX_PAGES = 60;

let _pdfRunSeq = 0;

function pdfT(s, vars) {
  return typeof I18n !== "undefined" && I18n.t ? I18n.t(s, vars) : s;
}
function pdfToast(m, kind) {
  if (typeof toast === "function") toast(m, kind || "ok");
}
function pdfExtNoDot(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p || ""));
  return m ? m[1].toLowerCase() : "";
}
/** 该路径是否是 PDF（app.js 的拖入分类 / 导入 / 文件行入口共用这一份判定） */
function pdfIsPdfPath(p) {
  return pdfExtNoDot(p) === "pdf";
}
function pdfFileName(p) {
  return String(p || "").split(/[\\/]/).pop() || String(p || "");
}
function pdfDirOf(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i > 0 ? s.slice(0, i) : "";
}
function pdfStemOf(p) {
  return pdfFileName(p).replace(/\.[^.]+$/, "") || "document";
}
function pdfErrText(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return String(err.message || err.error || err.code || "");
}

/* ============================ 进度窗（可取消） ============================ */

const PDF_DLG_TITLE = "解析 PDF 为 Markdown";
function pdfDialogTitle() {
  return pdfT(PDF_DLG_TITLE);
}
function pdfDialogLive() {
  const t = document.getElementById("ovTitle");
  const ov = document.getElementById("overlay");
  return !!(t && ov && ov.style.display === "flex" && t.textContent === pdfDialogTitle());
}

/** 进度窗：返回 { step / paint / note / fail / close }；打不开窗（无 openOverlay）返回 null */
function pdfProgressOpen(pdfPath, ctl) {
  if (typeof openOverlay !== "function") return null;
  openOverlay(pdfDialogTitle(), { persistent: true, min: false });
  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) return null;

  const head = document.createElement("div");
  head.className = "settings-hint";
  head.textContent = pdfFileName(pdfPath);
  head.title = pdfPath;
  body.appendChild(head);

  const msg = document.createElement("div");
  msg.style.cssText = "margin-top:10px;font-size:13px;";
  msg.textContent = pdfT("准备中…");
  body.appendChild(msg);

  const barWrap = document.createElement("div");
  barWrap.style.cssText =
    "margin-top:8px;height:6px;border-radius:3px;background:var(--bd,#2a2a2d);overflow:hidden";
  const bar = document.createElement("i");
  bar.style.cssText =
    "display:block;height:100%;width:0;background:var(--cyan,#38d6ff);transition:width .2s";
  barWrap.appendChild(bar);
  body.appendChild(barWrap);

  const log = document.createElement("div");
  log.style.cssText =
    "margin-top:10px;max-height:180px;overflow:auto;font-size:12px;line-height:1.6;" +
    "opacity:.85;white-space:pre-wrap;word-break:break-word";
  body.appendChild(log);

  const mkBtn = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = cls || "mini";
    b.textContent = label;
    b.onclick = fn;
    foot.appendChild(b);
    return b;
  };
  const cancelBtn = mkBtn(pdfT("取消"), "mini", () => {
    if (ctl.cancelled) return;
    ctl.cancelled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = pdfT("正在取消…");
    note(pdfT("已请求取消：当前页结束后停下，已完成的页面会保留。"));
    try {
      if (typeof dshCancelActive === "function") dshCancelActive(ctl.runKey);
    } catch (_) {}
  });
  const closeBtn = mkBtn(pdfT("关闭"), "mini", () => ui.close());

  const note = (line) => {
    const s = String(line == null ? "" : line);
    if (!s) return;
    log.textContent = log.textContent ? log.textContent + "\n" + s : s;
    log.scrollTop = log.scrollHeight;
  };
  const ui = {
    step(label) {
      msg.textContent = String(label || "");
    },
    paint(done, total, label) {
      const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
      bar.style.width = pct + "%";
      msg.textContent =
        String(label || "") + (total > 0 ? "（" + done + "/" + total + "）" : "");
    },
    note,
    fail(text) {
      bar.style.width = "100%";
      bar.style.background = "var(--red,#ff5f56)";
      msg.textContent = pdfT("解析失败");
      note(String(text || ""));
      cancelBtn.hidden = true;
    },
    close() {
      if (pdfDialogLive()) {
        try {
          closeOverlay();
        } catch (_) {}
      }
    },
  };
  closeBtn.style.display = "none";
  /* 只有失败态才需要「关闭」按钮（成功路径由代码自己收窗） */
  const origFail = ui.fail;
  ui.fail = (text) => {
    origFail(text);
    closeBtn.style.display = "";
  };
  return ui;
}

/* ============================ 运行控制块 ============================ */

function pdfRunNew() {
  const runKey = "pdf:" + ++_pdfRunSeq + ":" + Date.now().toString(36);
  const ctl = {
    runKey,
    cancelled: false,
    ui: null,
    total: 0,
    done: 0,
    step(label) {
      if (ctl.ui) ctl.ui.step(label);
    },
    paint(done, total, label) {
      ctl.done = done;
      ctl.total = total;
      if (ctl.ui) ctl.ui.paint(done, total, label);
    },
    note(line) {
      if (ctl.ui) ctl.ui.note(line);
    },
    cancel() {
      if (ctl.cancelled) return;
      ctl.cancelled = true;
      try {
        if (typeof dshCancelActive === "function") dshCancelActive(runKey);
      } catch (_) {}
    },
  };
  return ctl;
}

/* ============================ ① 结构化解析 ============================ */

/** 只跑「结构化解析」这一档（无 UI、无落盘）：拖入 PDF 的探路调用 */
async function pdfStructuredMarkdown(pdfPath, opts) {
  const api = window.api || {};
  const path = String(pdfPath || "").trim();
  if (!path) return { ok: false, markdown: "", error: pdfT("未提供 PDF 路径") };
  if (typeof api.fileParsePdf !== "function") {
    return {
      ok: false,
      markdown: "",
      error: pdfT("当前版本没有 PDF 解析通道（缺少 pdf:parse）"),
    };
  }
  /* 附带 pageImages：新内核若支持一并回传页面图，第 ② 档就不用再单独要一次 */
  const arg = Object.assign({ path, pageImages: true }, (opts && opts.arg) || {});
  let info = null;
  if (typeof api.filePdfInfo === "function") {
    try {
      info = await api.filePdfInfo(arg);
    } catch (_) {
      info = null;
    }
  }
  if (info && info.isPdf === false) {
    return {
      ok: false,
      markdown: "",
      error: info.warning || pdfT("不是 PDF 文件"),
      info,
    };
  }
  if (info && info.encrypted) {
    return {
      ok: false,
      markdown: "",
      error: pdfT("PDF 已加密（/Encrypt）：无法抽取文本，也无法渲染页面识图"),
      encrypted: true,
      info,
    };
  }
  let r = null;
  try {
    r = await api.fileParsePdf(arg);
  } catch (e) {
    r = { ok: false, error: { message: String((e && e.message) || e) } };
  }
  if (!r) return { ok: false, markdown: "", error: pdfT("PDF 解析没有返回结果"), info };
  if (r.ok === false) {
    return {
      ok: false,
      markdown: "",
      error: pdfErrText(r.error) || pdfT("PDF 解析失败"),
      raw: r,
      info,
    };
  }
  const md = String(r.markdown || "");
  return {
    ok: !!md.trim(),
    markdown: md,
    warning: String(r.warning || ""),
    pages: Number(r.pages) || 0,
    formulas: Array.isArray(r.formulas) ? r.formulas : [],
    raw: r,
    info,
  };
}

/* ============================ ② 逐页识图 ============================ */

/** 视觉路由：先走 app-db 的既有选型（与服务商里勾选「支持视觉」的模型一致），再退回识图路由 */
function pdfVisionRoute() {
  try {
    if (typeof dbFirstVisionModel === "function") {
      const v = dbFirstVisionModel();
      if (v && v.provider && v.model) return { provider: String(v.provider), model: String(v.model) };
    }
  } catch (_) {}
  try {
    if (typeof resolveVisionInspectRoute === "function") {
      const r = resolveVisionInspectRoute("");
      if (r && r.model) return { provider: "mtnode_" + String(r.provider.id || ""), model: String(r.model) };
    }
  } catch (_) {}
  return null;
}

function pdfPagePrompt(pageNo, total) {
  return (
    pdfT("下面是 PDF 第 {page}/{total} 页的页面图。请把这页内容完整转成 Markdown：", {
      page: pageNo,
      total: total,
    }) +
    "\n" +
    pdfT(
      "- 标题用 # / ## / ###（按字号层级），列表用 - / 1.，表格用 Markdown 表格，插图用 ![image](简述) 占位；\n" +
        "- 数学公式一律 LaTeX：行内 $...$，独立公式 $$...$$（分式、根号、上下标、矩阵、积分都要还原全）；\n" +
        "- 保持原文阅读顺序与层级，逐行完整转录：不要总结、不要翻译、不要解释；\n" +
        "- 页眉页脚与页码可省略；认不准的字符写成 [?]；\n" +
        "只输出该页的 Markdown 正文，不要任何前后缀。",
    )
  );
}

/** 一页一次识图调用（dshRunTask + images）；失败不吞掉，返回 error 由上层决定 */
async function pdfVisionPage(imagePath, pageNo, total, route, ctl) {
  const text = await dshRunTask(pdfPagePrompt(pageNo, total), {
    images: [imagePath],
    provider: route.provider,
    model: route.model,
    effort: "low",
    preset: "standard",
    runKey: ctl.runKey,
    tokTitle: pdfT("PDF 识图") + " p" + pageNo + "/" + total,
  });
  return String(text || "").trim();
}

function pdfUniqPath(base, ext) {
  return base + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e4) + ext;
}

/** 字节数组（Array / TypedArray）→ base64（主进程回传原始图像字节时用） */
function pdfBytesToBase64(arr) {
  try {
    const u8 = arr instanceof Uint8Array ? arr : Uint8Array.from(arr);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  } catch (_) {
    return "";
  }
}

/** 从 base64 头部嗅图片类型（回执没给 ext 时用；认不出按 png） */
function pdfSniffImageExt(b64) {
  const s = String(b64 || "").slice(0, 16);
  if (s.startsWith("/9j/")) return "jpg";
  if (s.startsWith("iVBOR")) return "png";
  if (s.startsWith("R0lGOD")) return "gif";
  if (s.startsWith("UklGR")) return "webp";
  if (s.startsWith("Qk")) return "bmp";
  return "png";
}

/** 数据 URL / base64（或原始字节数组）→ 工作流资产里的真实图片文件（识图必须吃本机绝对路径） */
async function pdfSaveBase64Image(b64, ext, nameHint) {
  const api = window.api || {};
  if (typeof api.assetWriteBase64 !== "function") return "";
  const isBytes =
    Array.isArray(b64) ||
    (b64 && typeof b64 !== "string" && b64.byteLength != null && b64.buffer);
  const src = isBytes ? pdfBytesToBase64(b64) : b64;
  const raw = String(src || "").replace(/^data:[^,]*,/, "");
  if (!raw) return "";
  const wfId = (typeof S !== "undefined" && S && S.wf && S.wf.id) || "";
  const name = String(nameHint || "img").replace(/[^\w.-]+/g, "_") || "img";
  const e =
    String(ext || "").toLowerCase().replace(/^image\//, "").replace(/^\./, "") ||
    pdfSniffImageExt(raw);
  try {
    const r = await api.assetWriteBase64(wfId, pdfUniqPath(name, ""), raw, e);
    return r && r.path ? String(r.path) : "";
  } catch (_) {
    return "";
  }
}

/** 把一份「页面图」回执（主进程渲染通道 / 解析结果里带的内嵌图）归一成 [{page, path}] */
async function pdfNormalizeImageList(ret, nameHint, savePrefix) {
  const out = [];
  const items = Array.isArray(ret)
    ? ret
    : ret && Array.isArray(ret.images)
      ? ret.images
      : ret && Array.isArray(ret.pages)
        ? ret.pages
        : ret && Array.isArray(ret.paths)
          ? ret.paths
          : [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (typeof it === "string") {
      out.push({ page: i + 1, path: it });
      continue;
    }
    const page = Number(it.page || it.index || it.pageNo || it.n || i + 1) || i + 1;
    const p = String(it.path || it.file || it.imagePath || "");
    if (p) {
      out.push({ page, path: p });
      continue;
    }
    const b64 = it.dataUrl || it.base64 || it.data || it.bytes || it.png || it.image || "";
    if (!b64) continue;
    const saved = await pdfSaveBase64Image(
      b64,
      it.ext || it.type || "",
      (savePrefix || nameHint || "pdf-page") + "-p" + page,
    );
    if (saved) out.push({ page, path: saved });
  }
  return out;
}

/** 解析结果里自带的内嵌页图（新内核若回传 pages[].image / pages[].images[]）→ 落成图片文件 */
async function pdfImagesFromParse(parse, pdfPath) {
  const pages = parse && Array.isArray(parse.pages) ? parse.pages : [];
  const prefix = "pdf-" + (pdfStemOf(pdfPath) || "doc").slice(0, 24);
  let list = pages;
  if (!list.length && parse && Array.isArray(parse.pageImages)) list = parse.pageImages;
  if (!list.length && parse && Array.isArray(parse.images)) list = parse.images;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const pg = list[i] || {};
    const page = Number(pg.page || pg.index + 1 || i + 1) || i + 1;
    const inner = Array.isArray(pg.images) && pg.images.length ? pg.images : [pg];
    for (const im of inner) {
      if (!im) continue;
      const p = String(im.path || im.file || "");
      if (p) {
        out.push({ page, path: p });
        continue;
      }
      const b64 = im.dataUrl || im.base64 || im.data || im.png || "";
      if (!b64) continue;
      const saved = await pdfSaveBase64Image(b64, im.ext || im.type || "", prefix + "-p" + page);
      if (saved) out.push({ page, path: saved });
    }
  }
  /* 同一页可能抽到多张图：按页号排序，页内保持出现顺序 */
  out.sort((a, b) => a.page - b.page);
  return out;
}

/** 可能的「PDF 页面 → 图片」渲染通道名：先试约定名，再动态认领 window.api 里 pdf 相关的其余函数
    （渲染通道属于主进程侧能力，命名可能演进：认领不过来时第 ② 档会给出可读错误而不是硬报错） */
function pdfRenderChannelNames() {
  const api = window.api || {};
  const out = [];
  const known = ["pdfRenderPages", "fileRenderPdfPages", "pdfPageImages"];
  for (const n of known) if (typeof api[n] === "function") out.push(n);
  for (const n of Object.keys(api)) {
    if (out.indexOf(n) >= 0) continue;
    if (!/pdf/i.test(n)) continue;
    if (/parse|probe|info|read|write/i.test(n)) continue;
    if (typeof api[n] !== "function") continue;
    out.push(n);
  }
  return out;
}

/** 取页面图：① 主进程页面渲染通道 → ② 解析结果自带的内嵌页图；都没有返回 [] */
async function pdfCollectPageImages(pdfPath, parse, ctl) {
  const api = window.api || {};
  const names = pdfRenderChannelNames();
  for (const n of names) {
    if (typeof api[n] !== "function") continue;
    ctl.note(pdfT("页面渲染通道：") + n);
    let r = null;
    try {
      r = await api[n]({ path: pdfPath, pageImages: true });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (r && r.ok === false) {
      ctl.note(pdfT("页面渲染失败：") + (pdfErrText(r.error) || pdfT("未知错误")));
      continue;
    }
    const list = await pdfNormalizeImageList(r, "pdf-page", "pdf-" + pdfStemOf(pdfPath).slice(0, 24));
    if (list.length) return list;
  }
  const emb = await pdfImagesFromParse(parse, pdfPath);
  if (emb.length) ctl.note(pdfT("使用 PDF 内嵌页面图（{n} 张）", { n: emb.length }));
  return emb;
}

/** 第 ② 档：逐页识图 → Markdown。返回 { ok, markdown, error, cancelled, pages } */
async function pdfVisionParse(pdfPath, parse, ctl, opts) {
  const imgs = await pdfCollectPageImages(pdfPath, parse, ctl);
  if (!imgs.length) {
    return {
      ok: false,
      markdown: "",
      error: pdfT("没有拿到可识图的页面图（当前版本未提供 PDF 页面渲染通道）"),
    };
  }
  const route = pdfVisionRoute();
  if (!route) {
    return {
      ok: false,
      markdown: "",
      error: pdfT(
        "未配置支持识图的模型：请在「设置 → 模型服务」里给服务商勾选「支持视觉」，" +
          "并把视觉模型排到该服务商列表最前（DeepSeek 官方不支持识图）",
      ),
    };
  }
  const cap = Math.min(imgs.length, PDF_VISION_MAX_PAGES);
  ctl.note(
    pdfT("识图模型：{provider} / {model}", { provider: route.provider, model: route.model }),
  );
  if (cap < imgs.length) {
    ctl.note(
      pdfT("页面较多：本轮只处理前 {cap} 页（共 {n} 页），其余可在文件节点上再次解析", {
        cap: cap,
        n: imgs.length,
      }),
    );
  }
  const parts = [];
  const failures = [];
  let cancelled = false;
  for (let i = 0; i < cap; i++) {
    if (ctl.cancelled) {
      cancelled = true;
      break;
    }
    const pg = imgs[i];
    ctl.paint(i, cap, pdfT("逐页识图"));
    try {
      const body = await pdfVisionPage(pg.path, pg.page, cap, route, ctl);
      parts.push(
        "<!-- page " + pg.page + " -->\n\n" + (body || pdfT("（本页未识别到内容）")),
      );
      ctl.note(pdfT("第 {n} 页完成", { n: pg.page }));
    } catch (e) {
      const msg = String((e && e.message) || e);
      failures.push(pdfT("第 {n} 页", { n: pg.page }) + "：" + msg);
      ctl.note(pdfT("第 {n} 页失败：", { n: pg.page }) + msg);
      if (ctl.cancelled) {
        cancelled = true;
        break;
      }
    }
  }
  ctl.paint(parts.length, cap, cancelled ? pdfT("已取消") : pdfT("逐页识图"));
  if (!parts.length) {
    return {
      ok: false,
      markdown: "",
      error:
        (cancelled ? pdfT("已取消") + "；" : "") +
        (failures.length ? failures.join("；") : pdfT("逐页识图没有产出内容")),
      cancelled,
      failures,
    };
  }
  const head =
    "<!-- 由 MTNode 逐页识图还原（视觉模型）：" +
    pdfFileName(pdfPath) +
    " · " +
    parts.length +
    "/" +
    imgs.length +
    " 页 -->";
  let md = head + "\n\n" + parts.join("\n\n");
  if (failures.length) md += "\n\n<!-- 失败页：" + failures.join("；") + " -->";
  if (cancelled) md += "\n\n<!-- 用户取消：仅包含已完成的页面 -->";
  return {
    ok: true,
    markdown: md.trim() + "\n",
    pages: parts.length,
    failures,
    cancelled,
  };
}

/* ============================ ③ 可读错误 ============================ */

function pdfReadableError(st, vs) {
  const lines = [];
  lines.push(pdfT("这份 PDF 没能转成 Markdown，失败原因如下："));
  if (st && st.error) lines.push("· " + pdfT("结构化解析：") + st.error);
  else lines.push("· " + pdfT("结构化解析：未提取到文本层（可能是扫描件或图片版 PDF）"));
  if (vs && vs.error) lines.push("· " + pdfT("逐页识图：") + vs.error);
  lines.push(
    pdfT(
      "可行的办法：① 在「设置 → 模型服务」配置一个支持识图的模型后重试（扫描件走逐页识图）；" +
        "② 换一份带文本层的 PDF；③ 若 PDF 已加密，先去掉密码再解析。",
    ),
  );
  return lines.join("\n");
}

/* ============================ 结果交付 ============================ */

/** 输出路径：默认落在源 PDF 同目录的 <同名>.md；该目录写不动就退到画布工作目录 */
async function pdfOutputPath(pdfPath, opts) {
  if (opts && opts.writePath) return String(opts.writePath);
  const dir = pdfDirOf(pdfPath);
  if (dir) return window.api.pathJoin(dir, pdfStemOf(pdfPath) + ".md");
  const ws = typeof wfWorkspace === "function" ? wfWorkspace() : "";
  if (ws) return window.api.pathJoin(ws, pdfStemOf(pdfPath) + ".md");
  return "";
}

async function pdfWriteMarkdown(pdfPath, markdown, opts) {
  const api = window.api || {};
  const primary = await pdfOutputPath(pdfPath, opts);
  const cands = [];
  if (primary) cands.push(primary);
  const ws = typeof wfWorkspace === "function" ? wfWorkspace() : "";
  if (ws) {
    const alt = api.pathJoin(ws, pdfStemOf(pdfPath) + ".md");
    if (cands.indexOf(alt) < 0) cands.push(alt);
  }
  let lastErr = "";
  for (const p of cands) {
    try {
      const r = await api.fileWriteText(p, markdown);
      if (r && r.ok === false) {
        lastErr = pdfErrText(r.error) || pdfT("写入失败");
        continue;
      }
      return { ok: true, path: p };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return { ok: false, error: lastErr || pdfT("没有可写出的目录（先给画布设一个工作目录）") };
}

/** 收口：进节点正文 / 写成 .md 并交给 Markdown 编辑器 / 纯返回（silent） */
async function pdfFinish(pdfPath, markdown, info, ctl, opts) {
  const res = { ok: true, markdown: markdown, tier: info && info.tier, pages: (info && info.pages) || 0 };
  if (ctl.ui) ctl.paint(1, 1, pdfT("完成"));
  if (opts.silent) {
    if (ctl.ui) ctl.ui.close();
    return res;
  }
  if (opts.node) {
    const node = opts.node;
    try {
      if (typeof pushHistory === "function") pushHistory();
    } catch (_) {}
    node.text = markdown;
    node.error = null;
    try {
      if (typeof clearDownstream === "function") clearDownstream(node.id);
      if (typeof scheduleSave === "function") scheduleSave();
      if (typeof renderCanvas === "function") renderCanvas();
    } catch (_) {}
    if (ctl.ui) ctl.ui.close();
    pdfToast(
      pdfT("已把 PDF 解析结果写入文本节点（{n} 字）", { n: markdown.length }),
      "ok",
    );
    return res;
  }
  const w = await pdfWriteMarkdown(pdfPath, markdown, opts);
  if (!w.ok) {
    const e = pdfT("解析成功但没能写出 Markdown：") + w.error;
    if (ctl.ui) ctl.ui.fail(e);
    pdfToast(e, "err");
    return { ok: false, error: e, markdown: markdown };
  }
  res.outputPath = w.path;
  if (ctl.ui) ctl.ui.close();
  pdfToast(pdfT("已生成 Markdown：") + w.path, "ok");
  if (typeof openMdViewer === "function") {
    try {
      await openMdViewer(w.path, { force: true });
    } catch (_) {}
  }
  return res;
}

/* ============================ 唯一入口 ============================ */

/**
 * 解析一份 PDF 为 Markdown（结构化 → 逐页识图 → 可读错误）。
 * opts:
 *   node        input_text 节点：结果写进节点正文（拖入 / 文本节点「导入」）
 *   writePath   指定输出的 .md 路径（缺省 = 源 PDF 同目录 <同名>.md）
 *   visionOnly  true = 跳过第 ① 档（拖入时已探过文本层），直接逐页识图
 *   silent      true = 不弹窗、不落盘、不投递，只把结果返回给调用方
 *   arg         透传给主进程 pdf:parse 的额外参数
 * 返回 { ok, markdown, tier, error, pages, outputPath? }
 */
async function openPdfParse(pdfPath, opts) {
  opts = opts || {};
  const path = String(pdfPath || "").trim();
  if (!path) {
    pdfToast(pdfT("未提供 PDF 路径"), "warn");
    return { ok: false, error: pdfT("未提供 PDF 路径") };
  }
  if (!pdfIsPdfPath(path)) {
    const e = pdfT("不是 PDF 文件：") + pdfFileName(path);
    pdfToast(e, "warn");
    return { ok: false, error: e };
  }
  if (!window.api || typeof window.api.fileParsePdf !== "function") {
    const e = pdfT("当前版本没有 PDF 解析通道（缺少 pdf:parse）");
    pdfToast(e, "err");
    return { ok: false, error: e };
  }
  const ctl = pdfRunNew();
  if (!opts.silent) ctl.ui = pdfProgressOpen(path, ctl);

  /* ① 结构化解析（文本层） */
  let st = { ok: false, markdown: "", error: "" };
  if (!opts.visionOnly) {
    ctl.step(pdfT("① 结构化解析（抽取文本层）…"));
    st = await pdfStructuredMarkdown(path, opts);
    if (st.ok) {
      ctl.note(pdfT("结构化解析完成：{n} 字", { n: st.markdown.trim().length }));
      if (st.warning) ctl.note(st.warning);
      return await pdfFinish(path, st.markdown, Object.assign({}, st, { tier: "structured" }), ctl, opts);
    }
    ctl.note(pdfT("结构化解析未拿到文本层：") + (st.error || pdfT("（空文本）")));
  }
  if (st.encrypted) {
    const e = st.error || pdfT("PDF 已加密，无法解析");
    if (ctl.ui) ctl.ui.fail(e);
    else pdfToast(e, "err");
    return { ok: false, error: e, tier: "error", encrypted: true };
  }

  /* ② 逐页识图（视觉模型） */
  ctl.step(pdfT("② 无文本层：逐页识图转 Markdown…"));
  const vs = await pdfVisionParse(path, st.raw || null, ctl, opts);
  if (vs.ok && String(vs.markdown || "").trim()) {
    return await pdfFinish(path, vs.markdown, Object.assign({}, vs, { tier: "vision" }), ctl, opts);
  }

  /* ③ 可读错误 */
  const err = pdfReadableError(st, vs);
  if (ctl.ui) ctl.ui.fail(err);
  else pdfToast(err, "err");
  return { ok: false, error: err, tier: "error", structured: st, vision: vs };
}

/* 全局出口（index.html 的脚本顺序保证 app.js / app-db.js 都已加载） */
window.openPdfParse = openPdfParse;
window.pdfStructuredMarkdown = pdfStructuredMarkdown;
window.pdfIsPdfPath = pdfIsPdfPath;

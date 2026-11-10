"use strict";
/* ============================================================================
 * PDF → Markdown 渲染层解析编排（renderer/pdf-markdown.js）
 * ----------------------------------------------------------------------------
 * 唯一入口：window.openPdfParse(pdfPath, opts)
 *
 * 三档降级（不是静默空文本，每一步都给可读理由）：
 *   ① 结构化解析：主进程 pdf:probe / pdf:parse（pdf-read.js = pdf.js 内核）抽取文本层 →
 *      标题 / 段落 / 列表 / 表格 / 公式占位，直接出 Markdown；
 *   ② 文本层不可用（没有文本层 = 扫描件 / 图片版，或抽出来是乱码 = 字体缺 Unicode 映射，
 *      数学论文常见）：逐页识图 —— 主进程 pdf:render 把页面渲成 PNG，再用视觉模型
 *      + dshRunTask({ images:[页图] }) 逐页转成 Markdown（公式走 LaTeX），
 *      结果按 <!-- page N --> 逐页拼接；
 *   ③ ①② 都不成：给一条可读错误（缺页面渲染通道 / 需要打开口令 …）。
 *
 * 首次识图会先问一次「允许把页面图发给模型服务吗」（持久确认窗），选择记进
 * config.json 的 pdf.visionConsent / pdf.maxVisionPages（0 = 全篇），之后不再打扰。
 *
 * 进度与取消：整轮走一次 openOverlay 进度窗（持久窗，不点外部关闭），逐页刷新进度，
 * 「取消」= 立刻 dshCancelActive(本轮的 runKey) 并在页间停下；已完成页保留。
 *
 * 消费方（都在调用期按 typeof 取本文件的全局函数）：
 *   · 文本节点「导入」对话框：app.js importFileToText（filters 里有 PDF 一项）
 *   · 文件节点行上的「解析为 Markdown」：app-db.js dbFileRowEl
 *   （**拖入 PDF 不再自动解析**：app.js createNodesFromDroppedFiles 直接把原 PDF 建成
 *     普通「文件节点」（input_any，只登记本机路径）保留原样式，解析只由用户在上面两处主动点。）
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
    /* pdf.js 会自己先用空口令解一次；走到这里说明**真要口令**（出版商的 AES 加密多有口令，
       普通「限制复制」类加密已经在上一步被空口令放行了） */
    return {
      ok: false,
      markdown: "",
      error: pdfT("PDF 需要打开口令（已先试过空口令），无法抽取文本，也无法渲染页面识图"),
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
    const code = String((r.error && r.error.code) || "");
    return {
      ok: false,
      markdown: "",
      error: pdfErrText(r.error) || pdfT("PDF 解析失败"),
      /* 需要口令 = 连页面也渲不出来，第 ② 档不用白跑一趟 */
      encrypted: code === "password_required" || code === "encrypted",
      raw: r,
      info,
    };
  }
  const md = String(r.markdown || "");
  const quality = r.quality && typeof r.quality === "object" ? r.quality : null;
  return {
    ok: !!md.trim(),
    markdown: md,
    warning: String(r.warning || ""),
    pages: Number(r.pages) || 0,
    pagesWithText: Number(r.pagesWithText || 0),
    emptyPages: Number(r.emptyPages || 0),
    quality: quality,
    formulas: Array.isArray(r.formulas) ? r.formulas : [],
    raw: r,
    info,
  };
}

/** 文本层能不能直接交付：乱码 / 大半页没文字 → 一律降级去识图。
    返回 { usable, reason }（reason 会写进进度窗，用户看得见为什么改道）。 */
function pdfTextLayerUsable(st) {
  if (!st || !st.ok) return { usable: false, reason: "" };
  const q = st.quality;
  if (q && q.garbled) {
    return {
      usable: false,
      reason: pdfT("文本层编码不可靠（字体缺少 Unicode 映射，抽出来是乱码），改走逐页识图"),
    };
  }
  if (st.pages >= 2 && st.emptyPages && st.emptyPages / st.pages >= 0.5) {
    return {
      usable: false,
      reason: pdfT("超过一半的页面抽不到文字（可能是扫描件），改走逐页识图"),
    };
  }
  return { usable: true, reason: "" };
}

/* ── 逐页识图的用户偏好（config.json 的 pdf 段）：同意过一次就不再问 ── */
function pdfVisionPref() {
  let c = null;
  try {
    c = typeof S !== "undefined" && S && S.config ? S.config : null;
  } catch (_) {
    c = null;
  }
  const o = c && c.pdf && typeof c.pdf === "object" ? c.pdf : {};
  return {
    consent: o.visionConsent === true,
    maxPages: Number(o.maxVisionPages) || 0,
  };
}

async function pdfVisionPrefSave(patch) {
  try {
    if (typeof S === "undefined" || !S || !S.config) return;
    S.config.pdf = Object.assign({}, (S.config.pdf && typeof S.config.pdf === "object" ? S.config.pdf : {}), patch);
    if (window.api && typeof window.api.configSave === "function") await window.api.configSave(S.config);
  } catch (_) {}
}

/** 首次识图前确认一次：页面图会外传 + 计费，用户得有知情权；选择随后记进设置。
    返回 { allowed, maxPages, model? }。 */
async function pdfVisionConsent(route) {
  const pref = pdfVisionPref();
  if (pref.consent) return { allowed: true, maxPages: pref.maxPages };
  const who = route ? route.provider + " / " + route.model : pdfT("当前 / 默认模型");
  const msg =
    pdfT("这份 PDF 的文本层不可用，要把它转成 Markdown 只能逐页识图。") +
    "\n\n" +
    pdfT("页面图会发送到模型服务（{m}）并按该服务计费。允许吗？", { m: who });
  let ok = false;
  try {
    ok = await confirmDialog(msg, {
      title: pdfT("逐页识图确认"),
      okText: pdfT("允许并继续"),
      cancelText: pdfT("不允许"),
    });
  } catch (_) {
    ok = false;
  }
  if (!ok) return { allowed: false, maxPages: 0 };
  let maxPages = 0;
  try {
    const ans = await promptDialog(
      pdfT("页数上限：超过这个页数只处理前面的部分（0 = 全篇）"),
      "0",
      { title: pdfT("逐页识图页数上限"), okText: pdfT("确定") },
    );
    maxPages = Math.max(0, Number(String(ans == null ? "" : ans).trim()) || 0);
  } catch (_) {
    maxPages = 0;
  }
  await pdfVisionPrefSave({ visionConsent: true, maxVisionPages: maxPages });
  return { allowed: true, maxPages };
}

/* ============================ ② 逐页识图 ============================ */

/** 视觉路由：能找到「明确的视觉模型」就优先用它，找不到返回 null 表示「用当前 / 默认模型直跑」
    （去闸：这里只是偏好，不是闸门 —— 没有它照样识图，真不吃图片时按上游报错如实说）。 */
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

/** 识图失败文案：API 明确说「不吃图片」→ 前面补「当前模型不支持图片输入」并原样带上游报错；
    其它错误原样透传（不替上游编理由）。判据见 app-db.js 的 visionImageUnsupportedText。 */
function pdfVisionFailText(err) {
  const msg = String((err && err.message) || err || "").trim();
  if (!msg) return pdfT("未知错误");
  const unsupported =
    typeof visionImageUnsupportedText === "function" &&
    visionImageUnsupportedText(msg);
  return unsupported ? pdfT("当前模型不支持图片输入") + "：" + msg : msg;
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

/** 一页一次识图调用（dshRunTask + images）；失败不吞掉，返回 error 由上层决定。
    route 可以为 null（没有明确的视觉路由）：那时不指定 provider / model，让 dshRunTask 用当前 /
    默认模型直跑 —— 去闸后的默认口径就是「先跑，不吃图片再如实报」。 */
async function pdfVisionPage(imagePath, pageNo, total, route, ctl) {
  const opts = {
    images: [imagePath],
    effort: "low",
    preset: "standard",
    runKey: ctl.runKey,
    tokTitle: pdfT("PDF 识图") + " p" + pageNo + "/" + total,
  };
  if (route && route.provider) opts.provider = route.provider;
  if (route && route.model) opts.model = route.model;
  const text = await dshRunTask(pdfPagePrompt(pageNo, total), opts);
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

/** 取页面图：① 主进程页面渲染通道（pdf:render）→ ② 解析结果自带的内嵌页图；都没有返回 [] */
async function pdfCollectPageImages(pdfPath, parse, ctl, opts) {
  const api = window.api || {};
  const o = opts || {};
  const names = pdfRenderChannelNames();
  for (const n of names) {
    if (typeof api[n] !== "function") continue;
    ctl.note(pdfT("页面渲染通道：") + n);
    let r = null;
    try {
      r = await api[n]({
        path: pdfPath,
        pageImages: true,
        /* 2 倍缩放 ≈ 144dpi：公式上下标在这个分辨率下还能认清，再高只是白烧内存 */
        scale: 2,
        maxPages: Number(o.maxPages) || 0,
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (r && r.ok === false) {
      ctl.note(pdfT("页面渲染失败：") + (pdfErrText(r.error) || pdfT("未知错误")));
      continue;
    }
    const list = await pdfNormalizeImageList(r, "pdf-page", "pdf-" + pdfStemOf(pdfPath).slice(0, 24));
    if (list.length) return { list, total: Number(r.pages) || list.length };
  }
  const emb = await pdfImagesFromParse(parse, pdfPath);
  if (emb.length) ctl.note(pdfT("使用 PDF 内嵌页面图（{n} 张）", { n: emb.length }));
  return { list: emb, total: emb.length };
}

/** 第 ② 档：逐页识图 → Markdown。返回 { ok, markdown, error, cancelled, pages } */
async function pdfVisionParse(pdfPath, parse, ctl, opts) {
  const route = pdfVisionRoute();
  /* 首次识图先问一次（页面图会外传 + 计费），同意后记进 config.json 的 pdf 段 */
  const consent = await pdfVisionConsent(route);
  if (!consent.allowed) {
    return {
      ok: false,
      markdown: "",
      error: pdfT("你未允许把页面图发给模型服务；需要时可在 config.json 的 pdf.visionConsent 打开"),
      denied: true,
    };
  }
  const budget = consent.maxPages > 0 ? consent.maxPages : PDF_VISION_MAX_PAGES;
  const got = await pdfCollectPageImages(pdfPath, parse, ctl, { maxPages: budget });
  const imgs = got.list;
  if (!imgs.length) {
    return {
      ok: false,
      markdown: "",
      error: pdfT("没有拿到可识图的页面图（页面渲染通道没返回图片）"),
    };
  }
  /* 去闸：找不到「明确的视觉模型」也照跑 —— 默就当当前模型能识图（dshRunTask 缺省取当前 / 默认模型）；
     真不吃图片时下面按 API 的原话如实报「当前模型不支持图片输入：<上游报错>」，不再提前拦死。 */
  const cap = Math.min(imgs.length, budget);
  ctl.note(
    route
      ? pdfT("识图模型：{provider} / {model}", { provider: route.provider, model: route.model })
      : pdfT("识图模型：当前模型（未单独指定视觉模型，按默认模型直跑）"),
  );
  if (got.total > cap) {
    ctl.note(
      pdfT("页面较多：本轮先处理前 {cap} 页（共 {n} 页），想多认几页就调高页数上限后重试", {
        cap: cap,
        n: got.total,
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
      const msg = pdfVisionFailText(e);
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
  else if (st && st.quality && st.quality.garbled)
    lines.push("· " + pdfT("结构化解析：文本层是乱码（字体缺少 Unicode 映射）"));
  else lines.push("· " + pdfT("结构化解析：未提取到文本层（可能是扫描件或图片版 PDF）"));
  if (vs && vs.error) lines.push("· " + pdfT("逐页识图：") + vs.error);
  lines.push(
    pdfT(
      "可行的办法：① 在「设置 → 模型服务」配置一个支持识图的模型后重试（扫描件与数学公式都要走逐页识图）；" +
        "② 若 PDF 需要打开口令，先去掉密码再解析；③ 换一份带可用文本层的 PDF。",
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

/* ── 图元落盘：正文里的占位符 → 真图文件 + 相对路径 ──────────────────────────
   pdf-read.js 只留锚点（主进程解析路径不写盘）：
     ![图 p3-1]({{FIG:p3-1.png}}) —— 位图已抽好，base64 在同一次解析结果的 figures[]
     ![第 N 页图表]({{PAGE:N}})    —— 纯矢量页，用 pdf:render 单页出图（scale 2 / 1600px）
   落盘位置 = md 同目录 / assets/<mdStem>/，正文换成相对路径。写不动就退成一条注记，
   渲染失败就把那一行删掉 —— 正文里绝不留 {{…}} 或指向不存在文件的链接。
   拖入 PDF（进文本节点正文）与「PDF 入库」节点（写成 .md）都经过 pdfFinish，行为一致。 */

const PDF_FIG_DIR = "assets";
/* 单页出图的参数：2 倍缩放 ≈ 144dpi，maxWidth 1600 让长边不爆内存 */
const PDF_PAGE_RENDER_ARG = { scale: 2, maxWidth: 1600 };

function pdfBase64ToBytes(b64) {
  try {
    const bin = atob(String(b64 || "").replace(/^data:[^,]*,/, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

/** 落盘目标：{ abs(绝对目录), rel(正文里的相对目录 "assets/<mdStem>") , stem }；没有目录 → null */
async function pdfFigureTarget(pdfPath, opts) {
  const api = window.api || {};
  let mdPath = "";
  try {
    mdPath = await pdfOutputPath(pdfPath, opts);
  } catch (_) {
    mdPath = "";
  }
  const dir = pdfDirOf(mdPath);
  if (!dir) return null;
  const stem = pdfStemOf(mdPath) || "document";
  const rel = PDF_FIG_DIR + "/" + stem;
  const abs =
    typeof api.pathJoin === "function"
      ? api.pathJoin(dir, PDF_FIG_DIR, stem)
      : dir + "\\" + PDF_FIG_DIR + "\\" + stem;
  return { abs, rel, stem };
}

/** 写一张图进目标目录：同名文件已存在就换序号（不覆盖别人的文件）；失败抛出原文 */
async function pdfFigureWrite(target, name, bytes) {
  const api = window.api || {};
  if (typeof api.fileWriteBytes !== "function") {
    throw new Error(pdfT("当前版本没有写文件通道（缺少 file:writeBytes）"));
  }
  const base = String(name || "fig.png").replace(/[^\w.-]+/g, "_") || "fig.png";
  const dot = base.lastIndexOf(".");
  const root = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : ".png";
  for (let i = 0; i < 200; i++) {
    const nm = i ? root + "-" + (i + 1) + ext : base;
    const abs =
      typeof api.pathJoin === "function" ? api.pathJoin(target.abs, nm) : target.abs + "\\" + nm;
    if (typeof api.fileExists === "function") {
      let exists = false;
      try {
        exists = !!(await api.fileExists(abs));
      } catch (_) {
        exists = false;
      }
      if (exists) continue;
    }
    const r = await api.fileWriteBytes(abs, bytes);
    if (r && r.ok === false) throw new Error(pdfErrText(r.error) || pdfT("写入失败"));
    return nm;
  }
  throw new Error(pdfT("同名文件太多，换不到可写的文件名"));
}

/** 单页出图（{{PAGE:n}}）：与逐页识图同一批渲染通道，只渲这一页。返回 { bytes } 或 { error } */
async function pdfRenderOnePage(pdfPath, pageNo) {
  const api = window.api || {};
  const names = pdfRenderChannelNames();
  if (!names.length) return { error: pdfT("当前版本没有页面渲染通道（缺少 pdf:render）") };
  let lastErr = "";
  for (const n of names) {
    let r = null;
    try {
      r = await api[n](Object.assign({ path: pdfPath, pages: [pageNo] }, PDF_PAGE_RENDER_ARG));
    } catch (e) {
      lastErr = String((e && e.message) || e);
      continue;
    }
    if (!r || r.ok === false) {
      lastErr = pdfErrText(r && r.error) || pdfT("未知错误");
      continue;
    }
    const list = Array.isArray(r.images) ? r.images : Array.isArray(r.pages) ? r.pages : [];
    /* 只认这一页：通道忽略了 pages 参数、回了整份页面图时不能拿错页 */
    let hit = list.filter((x) => x && Number(x.page) === Number(pageNo))[0] || null;
    if (!hit && list.length === 1 && !(list[0] && list[0].page)) hit = list[0];
    const b64 = hit && (hit.dataUrl || hit.base64 || hit.data || hit.png);
    if (!b64) {
      lastErr = pdfT("渲染通道没有返回这一页的图片");
      continue;
    }
    const bytes = pdfBase64ToBytes(b64);
    if (!bytes || !bytes.length) {
      lastErr = pdfT("页面图解码失败");
      continue;
    }
    return { bytes };
  }
  return { error: lastErr || pdfT("未知错误") };
}

function pdfFigureKey(name) {
  return String(name || "").replace(/\.png$/i, "");
}

function pdfEscRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 行级替换一个占位符：replacement 非空 = 只换锚点（保留外面的图片语法）；
    replacement 为空 = 整行换成 noteText（失败态：注记替代那条图，不留坏链接）。 */
function pdfReplaceAnchorLine(markdown, tokenRe, replacement, noteText) {
  const hit = new RegExp(tokenRe.source);
  const all = new RegExp(tokenRe.source, "g");
  const out = [];
  for (const l of String(markdown).split("\n")) {
    if (!hit.test(l)) {
      out.push(l);
      continue;
    }
    if (replacement) out.push(l.replace(all, () => replacement));
    else if (noteText) out.push(noteText);
  }
  return out.join("\n");
}

/**
 * 占位符 → 真图：{{FIG:name}} 写 figures[] 里的 base64，{{PAGE:n}} 单页渲染后落盘。
 * 返回 { markdown, figures, pages }，markdown 已经是可交付正文（无残留占位符）。
 */
async function pdfMaterializeFigures(markdown, parse, pdfPath, ctl, opts) {
  const md = String(markdown || "");
  const src = parse && typeof parse === "object" ? parse : {};
  const figs = Array.isArray(src.figures) ? src.figures : [];
  const hasFig = /\{\{\s*FIG:/.test(md);
  const hasPage = /\{\{\s*PAGE:\d+\s*\}\}/.test(md);
  const out = { markdown: md, figures: 0, pages: 0 };
  if (!md || (!hasFig && !hasPage)) return out;
  const note = (l) => {
    try {
      if (ctl && typeof ctl.note === "function") ctl.note(l);
    } catch (_) {}
  };
  /* silent = 不落盘（调用方的契约）：只把锚点收干净，一个文件都不写 */
  const silent = !!(opts && opts.silent);
  const target = silent ? null : await pdfFigureTarget(pdfPath, opts);
  if (!target && !silent) {
    note(pdfT("图元没能落盘：没有可写出的目录（先给画布设一个工作目录，或把 PDF 放到可写的位置）"));
  }

  /* ① 位图：figures[] 里带 base64，逐张写盘并记下相对路径 */
  let text = md;
  const figOk = new Map();   /* key → 相对路径（写成了） */
  const figBad = new Map();  /* key → 注记（已抽取但没落盘） */
  for (const f of figs) {
    const name = String((f && f.name) || "");
    const raw = f && (f.png || f.base64 || f.data);
    if (!name || !raw) continue;
    const key = pdfFigureKey(name);
    const bad = (err) =>
      figBad.set(
        key,
        pdfT("（图 {name} 已抽取但未落盘：{err}）", { name: name, err: err }),
      );
    if (!target) {
      bad(silent ? pdfT("本次不落盘") : pdfT("没有可写出的目录"));
      continue;
    }
    const bytes = pdfBase64ToBytes(raw);
    if (!bytes) {
      bad(pdfT("图片数据解码失败"));
      note(pdfT("图已抽取但未落盘：") + name + " · " + pdfT("图片数据解码失败"));
      continue;
    }
    try {
      const nm = await pdfFigureWrite(target, name, bytes);
      figOk.set(key, target.rel + "/" + nm);
      out.figures++;
    } catch (e) {
      const err = String((e && e.message) || e) || pdfT("写入失败");
      bad(err);
      note(pdfT("图已抽取但未落盘：") + name + " · " + err);
    }
  }
  if (out.figures) {
    note(pdfT("图元已落盘：{n} 张 → {dir}", { n: out.figures, dir: (target && target.abs) || "" }));
  }
  for (const [key, rel] of figOk) {
    text = pdfReplaceAnchorLine(text, new RegExp("\\{\\{\\s*FIG:" + pdfEscRe(key) + "(\\.png)?\\s*\\}\\}"), rel);
  }
  for (const [key, msg] of figBad) {
    text = pdfReplaceAnchorLine(
      text,
      new RegExp("\\{\\{\\s*FIG:" + pdfEscRe(key) + "(\\.png)?\\s*\\}\\}"),
      "",
      msg,
    );
  }
  /* 正文里有锚点却拿不到位图（figures 被关掉 / 预算截断）：同样不留坏引用 */
  const missing = [];
  const rest = /\{\{\s*FIG:([^}]+?)\s*\}\}/g;
  let fm;
  while ((fm = rest.exec(text))) {
    const nm = String(fm[1] || "");
    if (nm && missing.indexOf(nm) < 0) missing.push(nm);
  }
  for (const nm of missing) {
    const msg = pdfT("（图 {name} 未随解析结果返回）", { name: nm });
    text = pdfReplaceAnchorLine(text, new RegExp("\\{\\{\\s*FIG:" + pdfEscRe(nm) + "\\s*\\}\\}"), "", msg);
  }
  if (missing.length) {
    note(pdfT("这些图没有随解析结果返回，占位已去掉：") + missing.join("、"));
  }

  /* ② 整页图表：{{PAGE:n}} 单页出图落盘；渲染 / 写盘失败 = 注记替掉那一行并说明 */
  const pages = [];
  const pageScan = /\{\{\s*PAGE:(\d+)\s*\}\}/g;
  let pm;
  while ((pm = pageScan.exec(text))) {
    const n = Number(pm[1]);
    if (n > 0 && pages.indexOf(n) < 0) pages.push(n);
  }
  for (const n of pages) {
    let mark = "";
    let err = "";
    if (!target) {
      err = silent ? pdfT("本次不落盘") : pdfT("没有可写出的目录");
    } else {
      const r = await pdfRenderOnePage(pdfPath, n);
      if (r && r.bytes) {
        try {
          const nm = await pdfFigureWrite(target, "p" + n + ".png", r.bytes);
          mark = target.rel + "/" + nm;
          out.pages++;
        } catch (e) {
          err = String((e && e.message) || e) || pdfT("写入失败");
        }
      } else {
        err = (r && r.error) || pdfT("未知错误");
      }
    }
    if (!mark) {
      note(pdfT("整页图表渲染失败，已删掉这一行占位（第 {n} 页）：", { n: n }) + err);
    }
    /* 失败 = 整行删掉（noteText 传空），正文里不留指向不存在页图的链接 */
    text = pdfReplaceAnchorLine(text, new RegExp("\\{\\{\\s*PAGE:" + n + "\\s*\\}\\}"), mark);
  }
  if (out.pages) {
    note(pdfT("整页图表已出图：{n} 页 → {dir}", { n: out.pages, dir: (target && target.abs) || "" }));
  }
  out.markdown = text;
  return out;
}

/** 收口：进节点正文 / 写成 .md 并交给 Markdown 编辑器 / 纯返回（silent） */
async function pdfFinish(pdfPath, markdown, info, ctl, opts) {
  /* 占位符先换真图：这一步之后正文才是不带 {{…}} 的可交付稿（写盘与节点正文共用） */
  const fig = await pdfMaterializeFigures(markdown, info && info.raw, pdfPath, ctl, opts);
  markdown = fig.markdown;
  const res = {
    ok: true,
    markdown: markdown,
    tier: info && info.tier,
    pages: (info && info.pages) || 0,
    figures: fig.figures || 0,
    figurePages: fig.pages || 0,
  };
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
      /* 文本层抽到了不代表能用：字体缺 Unicode 映射时抽出来是乱码（数学论文的常见形态），
         这时静默改走逐页识图，别把一屏「⌉⌋⌊」当结果交给用户 */
      const use = pdfTextLayerUsable(st);
      if (use.usable) {
        return await pdfFinish(path, st.markdown, Object.assign({}, st, { tier: "structured" }), ctl, opts);
      }
      ctl.note(use.reason || pdfT("文本层不可用，改走逐页识图"));
    } else {
      ctl.note(pdfT("结构化解析未拿到文本层：") + (st.error || pdfT("（空文本）")));
    }
  }
  if (st.encrypted) {
    const e = st.error || pdfT("PDF 需要打开口令，无法解析");
    if (ctl.ui) ctl.ui.fail(e);
    else pdfToast(e, "err");
    return { ok: false, error: e, tier: "error", encrypted: true };
  }

  /* ② 文本层不可用：逐页识图（页面图 → 视觉模型） */
  ctl.step(pdfT("② 逐页识图转 Markdown…"));
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

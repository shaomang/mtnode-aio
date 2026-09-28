"use strict";
/* ============ 内嵌图片共享模块：粘贴 / 拖入 / 落盘 / 引用登记 / 无引用回收 ============
 * 出口：window.MTInlineImg（同层脚本只在调用期按 typeof 取用，无加载期依赖）。
 * 三处共用同一套能力：
 *   1) 审阅编辑器（renderer/app-review.js 的 .review-editor .rv-rich）；
 *   2) 画布节点正文框；
 *   3) 会话 / 助手输入框（<textarea>，见下「两版」）。
 * 调用方只负责给出「图片来源目标」描述符 target（见下），具体行为全在本模块：
 *   · 粘贴：剪贴板位图（含截图，走主进程 clipboardReadImage）/ 剪贴板里的图片文件项；
 *   · 拖入：本机图片文件（能取到本机路径就整路径引用，否则读 Blob 转 base64 落盘）；
 *   · 落盘：kind=fact → 复制进库级 assets/ 并以 assets/<name> 相对路径引用（可移植、可手改）；
 *           kind=path → 直接引用本机绝对路径（不复制文件）；
 *   · 入编辑器：<img src=可显示的 file:/// 绝对路径，data-rv-src=写回 md 的原始引用>；
 *   · 引用登记：collectImgRefs 纯函数，收集 ![](x) 的原始引用 + 裸文件名两种形态；
 *   · 无引用回收：只删「库内所有文档 · 全部版本」都不引用的图片（跨文档 / 回看 / 回滚引用一律保留）。
 *
 * 无引用回收（画布资产 / 输入框落盘目录）也在这里：normImgPath / imgRefsOfText / imgRefsIn /
 * orphanImages / isChatInputImage / isCanvasInlineImage 是一组纯函数，画布侧（app.js 的
 * gcCanvasInlineImages）与输入框侧（app-assist.js 的 chatImgGc）共用同一份判据 ——
 * 只删「本功能创建 ∧ 一处引用都没有」的图，用户自己的图片与别处产物从不进候选集。
 *
 * 两版（同一个「落盘 → 引用」内核，差别只在「插入什么」）：
 *   · 富文本版 bindEditor：插一个 <img>（src 可显示、data-rv-src 写回 md 的引用）；
 *   · textarea 版 bindTextarea：插一行 Markdown  ![名称](引用)，独占一行；
 *     输入框侧的胶囊条按 imgLines(value) 逐行解析，与正文行一一对应（渲染在调用方）。
 *   两版的粘贴 / 拖入来源解析（imageFileIn / isBareImagePaste / imageFilesIn / pathOfFile）
 *   完全共用，所以「截屏、从浏览器复制的图、资源管理器拖入」在两版里行为一致。
 *
 * target 描述符（按 kind 取用；传对象或「返回对象的函数」皆可，函数 = 每次调用期现取）：
 *   kind        "fact" 复制进 assets/ 写相对引用 · "path" 直接引用本机绝对路径（缺省）
 *   lib         事实库适配（joinPath / stripExt / dirNameOf / readReview / readDoc），fact 必需
 *   dir         库目录（assets/ 的父目录；GC 扫这里的所有 .md / *.review.json）
 *   assetsDir   库级共享插图目录（fact 必填，GC 只扫它）
 *   name        文档名（alt 兜底用）
 *   file        文档 md 绝对路径
 *   reviewFile  该文档的 review.json sidecar 路径
 *   skipSidecar 磁盘扫描时跳过的 sidecar（其正文由 refTexts 提供，比较时大小写不敏感）
 *   refTexts    () => string[]|null  内存里比磁盘新的正文（当前文档版本链）。
 *               返回 null / 非数组 = 该目标尚未就绪 → 本轮不做回收（绝不误删）
 *   saveBase64 可选 (picked) => {path, alt?}|string|null ：把「没有本机路径」的图片来源
 *               （剪贴板截图 / 内存 Blob）落盘成真文件并回绝对路径。会话 / 助手输入框用它
 *               （工作区里落一张真图再引用）；没给这个钩子时，这类来源按老口径提示不支持。
 *               picked.base64 已由本模块归一成**裸 base64**（见 stripDataUrl），调用方直接
 *               交给 file:writeBytes / atob 即可，不必自己剥 data URL 前缀。
 * opts（编辑区侧）：
 *   target      见上（对象或函数）
 *   canEdit     () => boolean  粘贴 / 拖入是否放行（缺省放行）
 *   onInserted  (saved) => void  插入成功后调用方的收尾（标脏 / 落回正文 / 刷状态条）
 *   onChanged   () => void  textarea 版：输入框内容变化（含粘贴 / 拖入后的收尾）时调用
 *
 * CSS：renderer/css/inline-img.css（.ii-pick-* 插图小对话框 / .ii-rich 编辑器内图片尺寸与选中态 /
 * .ii-line-chips 输入框上方胶囊条）。
 * 本模块不认识审阅 / 节点 / 会话的任何业务状态：目标与回调全部由调用方注入。
 */
(function () {
  const II = {};

  function T(s) {
    try {
      return I18n.t(s);
    } catch (_) {
      return String(s);
    }
  }
  function toastMsg(s, kind) {
    try {
      toast(s, kind);
    } catch (_) {}
  }
  function escH(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return escH(s).replace(/"/g, "&quot;");
  }

  /* ---------- base64 归一：两种形态都真实存在，落盘前必须收成一种 ----------
     裸 base64：主进程 clipboardReadImage 回的片段；
     整条 data URL：FileReader.readAsDataURL 的结果（剪贴板里的图片文件项 / 内存 Blob 走这条）。
     atob 只认裸 base64 —— data URL 直接喂进去抛 InvalidCharacterError（表现就是
     「图片落盘失败，无法插入」）；Buffer.from(x,"base64") 则**静默**写出坏字节（图坏了还不报错）。
     所以「落盘 / 写文件」之前一律先过 stripDataUrl，只留一处口径。 */
  function stripDataUrl(s) {
    const t = String(s == null ? "" : s);
    const i = t.indexOf("base64,");
    return i >= 0 ? t.slice(i + 7) : t;
  }
  /* 归一后的 base64 → 字节（file:writeBytes 只认字节，字符串会被当 utf8 写坏） */
  function base64Bytes(s) {
    const bin = atob(stripDataUrl(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------- 目标描述符（对象 / 函数都收） ---------- */
  function targetOf(opts) {
    const t = opts && opts.target !== undefined ? opts.target : opts;
    return typeof t === "function" ? t() : t || null;
  }
  function canEdit(opts) {
    const f = opts && opts.canEdit;
    if (typeof f !== "function") return true;
    try {
      return !!f();
    } catch (_) {
      return false;
    }
  }

  /* ---------- 基础：文件名 / 扩展名 / 本机路径 → 可显示的 file:/// URL ---------- */
  function baseName(p) {
    const s = String(p || "").replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function extOf(p) {
    const b = baseName(p);
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(i).toLowerCase() : "";
  }
  /* 复用画布层的统一口径（mediaFileUrlOf），缺桥时退回 api.toFileUrl。 */
  function fileUrl(p) {
    const s = String(p || "").trim();
    if (!s) return "";
    if (/^file:\/\//i.test(s)) return s;
    try {
      if (typeof mediaFileUrlOf === "function") {
        const u = mediaFileUrlOf(s);
        if (u) return u;
      }
    } catch (_) {}
    try {
      if (window.api && window.api.toFileUrl)
        return String(window.api.toFileUrl(s) || "") || s;
    } catch (_) {}
    return s;
  }

  /* ---------- 选区：记住 / 还原 / 光标落到插入节点之后 ---------- */
  function rangeIn(ed) {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.anchorNode && ed && ed.contains(sel.anchorNode))
        return sel.getRangeAt(0).cloneRange();
    } catch (_) {}
    return null;
  }
  function restoreRange(range, ed) {
    try {
      if (range) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (ed) ed.focus();
    } catch (_) {}
  }
  function placeCaretAfter(el) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStartAfter(el);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  /* 在编辑区光标处插入节点 / HTML；选区不在编辑区内（对话框夺焦后未还原）则追加到末尾。 */
  function insertAtCaret(ed, frag) {
    if (!ed || frag == null) return;
    const node =
      frag.nodeType ? frag : document.createRange().createContextualFragment(String(frag));
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.anchorNode && ed.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(node);
      placeCaretAfter(node.lastChild || node);
    } else {
      ed.appendChild(node);
    }
  }

  /* ---------- 落盘：拿到「相对引用 + 可显示 URL + alt」 ---------- */
  async function saveImage(picked, target) {
    const tg = targetOf(target);
    const lib = (tg && tg.lib) || null;
    const a = window.api;
    /* base64 先归一成裸 base64 再往下走（见 stripDataUrl）：fact 落盘与 saveBase64 钩子
       拿到的都是同一种形态，data URL 不会漏到 atob / Buffer.from(...,"base64") 里。 */
    const pk = picked
      ? Object.assign({}, picked, { base64: stripDataUrl(picked.base64) })
      : picked;
    if (tg && tg.kind === "fact" && tg.assetsDir) {
      if (!a || typeof a.factSaveImage !== "function") {
        toastMsg(T("事实库模块未就绪，无法插入图片"), "err");
        return null;
      }
      const r = await a.factSaveImage({
        dir: tg.assetsDir,
        srcPath: (pk && pk.srcPath) || "",
        base64: (pk && pk.base64) || "",
        name: String((pk && pk.name) || "image").replace(/\s+/g, "-"),
        ext: (pk && pk.ext) || "",
      });
      if (!r || !r.ok) {
        toastMsg(T("图片保存失败：") + ((r && r.error) || ""), "err");
        return null;
      }
      const rel = "assets/" + r.name;
      const abs = fileUrl(lib ? lib.joinPath(tg.dir, rel) : rel);
      return { rel: rel, abs: abs, alt: lib ? lib.stripExt(r.name) : r.name };
    }
    const p = String((pk && pk.srcPath) || "").trim();
    if (!p) {
      /* 目标自带 saveBase64 钩子（会话 / 助手输入框这类「正文按绝对路径引用、又没有事实库」的
         场景）：剪贴板截图 / 内存里的图片 Blob 压根没有本机路径，先交给调用方落盘成真文件，
         正文再引用那个绝对路径。钩子没回路径 = 落盘失败，绝不写一行指向不存在文件的引用。 */
      if (typeof tg.saveBase64 === "function" && pk && pk.base64) {
        let w = null;
        try {
          w = await tg.saveBase64(pk);
        } catch (_) {
          w = null;
        }
        const wp = String((w && w.path) || (typeof w === "string" ? w : "") || "").trim();
        if (wp)
          return {
            rel: wp,
            abs: fileUrl(wp),
            alt:
              String((w && w.alt) || "").trim() ||
              (lib ? lib.stripExt(baseName(wp)) : baseName(wp)),
          };
        toastMsg(T("图片落盘失败，无法插入"), "err");
        return null;
      }
      toastMsg(T("该目标不支持从剪贴板插入图片，请选择本机图片文件"), "warn");
      return null;
    }
    return {
      rel: p,
      abs: fileUrl(p),
      alt: lib ? lib.stripExt(baseName(p)) : baseName(p),
    };
  }

  /* ---------- 入编辑器：<img> ---------- */
  function imgHtml(saved) {
    return (
      '<img src="' +
      escAttr(saved.abs) +
      '" data-rv-src="' +
      escAttr(saved.rel) +
      '" alt="' +
      escAttr(saved.alt || "") +
      '">'
    );
  }
  function inserted(opts, saved) {
    const f = opts && opts.onInserted;
    if (typeof f === "function") {
      try {
        f(saved);
      } catch (_) {}
    }
  }
  function insertImgRich(ed, saved, opts) {
    if (!ed || !saved) return false;
    insertAtCaret(ed, imgHtml(saved));
    inserted(opts, saved);
    /* 目标传函数（现取）时把函数原样交给去抖回收，触发那刻再解析目标。 */
    gcOrphanImages(opts && opts.target !== undefined ? opts.target : opts);
    return true;
  }
  /* 工具栏「插入图片」：先记住选区 → 选择图片 → 落盘 → 还原选区 → 插入。 */
  function insertFromPicker(ed, opts) {
    const range = rangeIn(ed);
    return pickImage(targetOf(opts)).then(async (picked) => {
      if (!picked) return null;
      const saved = await saveImage(picked, targetOf(opts));
      if (!saved) return null;
      restoreRange(range, ed);
      insertImgRich(ed, saved, opts);
      return saved;
    });
  }

  /* ---------- 剪贴板 / 拖入 的「图片来源」解析（富文本版与 textarea 版共用） ---------- */
  /* 剪贴板里的一张图片文件项（从浏览器 / 资源管理器复制图片时是文件项，不是位图） */
  function imageFileIn(dt) {
    let file = null;
    if (dt) {
      for (const it of Array.from(dt.items || [])) {
        if (it.kind === "file" && /^image\//i.test(it.type || "")) {
          file = it.getAsFile();
          if (file) break;
        }
      }
      if (!file) {
        for (const f of Array.from(dt.files || [])) {
          if (/^image\//i.test(f.type || "")) {
            file = f;
            break;
          }
        }
      }
    }
    return file;
  }
  /* 剪贴板里既没有文本也没有文件项（多为截图）→ 该走主进程 clipboardReadImage 取位图 */
  function isBareImagePaste(dt) {
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    const hasText = types.some((t) => /^text\//i.test(t) || t === "text");
    const hasFiles = types.indexOf("Files") >= 0;
    return !hasText && !hasFiles;
  }
  /* 拖入的图片文件（全部；一次拖多张时 textarea 版逐张插成多行） */
  function imageFilesIn(dt) {
    return Array.from((dt && dt.files) || []).filter((f) =>
      /^image\//i.test(f.type || ""),
    );
  }
  /* 拖入文件的本机路径（取不到 = 沙箱 / 浏览器来源，只能读 Blob） */
  function pathOfFile(f) {
    try {
      if (window.api && window.api.getPathForFile)
        return String(window.api.getPathForFile(f) || "");
    } catch (_) {}
    return "";
  }
  /* 内存里的图片 Blob → 落盘入参（base64 + 名称 + 扩展名） */
  function blobToPicked(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        if (!dataUrl) return resolve(null);
        const m = /^data:([^;,]+)/i.exec(dataUrl);
        const mime = (m && m[1]) || "image/png";
        const ext = "." + mime.replace(/^image\//i, "").replace(/^jpeg$/i, "jpg");
        resolve({
          base64: stripDataUrl(dataUrl),
          name: file && file.name ? baseName(file.name) : "image",
          ext: ext,
        });
      };
      reader.onerror = () => resolve(null);
      try {
        reader.readAsDataURL(file);
      } catch (_) {
        resolve(null);
      }
    });
  }

  /* ---------- 富文本版：粘贴 / 拖入 → <img> ---------- */
  /* 图片 Blob → base64 → 落盘 → 还原选区 → 插入。 */
  function insertFromBlob(file, ed, opts) {
    blobToPicked(file).then((picked) => {
      if (!picked) return;
      const range = rangeIn(ed);
      saveImage(picked, targetOf(opts)).then((saved) => {
        if (!saved) return;
        restoreRange(range, ed);
        insertImgRich(ed, saved, opts);
      });
    });
  }
  /* 已有本机路径的图片文件（拖入）：整路径落盘（fact 目标下会复制进 assets/）。 */
  function insertFromPath(p, ed, opts) {
    return saveImage(
      { srcPath: p, name: baseName(p), ext: extOf(p) },
      targetOf(opts),
    ).then((saved) => {
      if (saved) insertImgRich(ed, saved, opts);
    });
  }
  /* 主进程剪贴板位图 → 落盘 → 还原选区 → 插入。 */
  function insertFromClipboard(ed, opts) {
    const a = window.api;
    if (!a || typeof a.clipboardReadImage !== "function") return;
    const range = rangeIn(ed);
    Promise.resolve(a.clipboardReadImage()).then(
      (r) => {
        if (!r || !r.ok) {
          toastMsg(T("剪贴板里没有图片"), "warn");
          return;
        }
        return saveImage(
          { base64: r.base64, name: "screenshot", ext: ".png" },
          targetOf(opts),
        ).then((saved) => {
          if (!saved) return;
          restoreRange(range, ed);
          insertImgRich(ed, saved, opts);
        });
      },
      () => {},
    );
  }
  /* 富文本粘贴：剪贴板位图（含截图）直接落盘插图，纯文本粘贴不拦截。 */
  function handlePaste(ev, ed, opts) {
    if (!canEdit(opts)) return;
    const dt = ev.clipboardData;
    const file = imageFileIn(dt);
    if (file) {
      ev.preventDefault();
      insertFromBlob(file, ed, opts);
      return;
    }
    /* 无文件项、且不是文本 / 文件粘贴（多为截图）→ 走主进程剪贴板取图 */
    if (isBareImagePaste(dt)) {
      ev.preventDefault();
      insertFromClipboard(ed, opts);
    }
  }
  /* 拖入：本机图片文件优先整路径引用，取不到路径才读 Blob。 */
  function handleDrop(ev, ed, opts) {
    if (!canEdit(opts)) return;
    const dt = ev.dataTransfer;
    const files = imageFilesIn(dt);
    if (!files.length) return;
    ev.preventDefault();
    const f = files[0];
    const p = pathOfFile(f);
    if (p) insertFromPath(p, ed, opts);
    else insertFromBlob(f, ed, opts);
  }
  /* 给编辑区一次性接好：paste / dragover / drop + 编辑器内图片选中态（同时只留一张）。
     图片选中态类名 .ii-img-sel，样式见 css/inline-img.css。 */
  function bindEditor(ed, opts) {
    if (!ed || !ed.addEventListener) return;
    if (!(opts && opts.richClass === false)) ed.classList.add("ii-rich");
    ed.addEventListener("paste", (ev) => handlePaste(ev, ed, opts));
    ed.addEventListener("dragover", (ev) => {
      const dt = ev.dataTransfer;
      if (dt && Array.from(dt.types || []).indexOf("Files") >= 0) {
        ev.preventDefault();
        dt.dropEffect = "copy";
      }
    });
    ed.addEventListener("drop", (ev) => handleDrop(ev, ed, opts));
    ed.addEventListener("click", (ev) => {
      const hit = ev.target && ev.target.tagName === "IMG" ? ev.target : null;
      Array.from(ed.querySelectorAll("img.ii-img-sel")).forEach((im) => {
        if (im !== hit) im.classList.remove("ii-img-sel");
      });
      if (hit) hit.classList.add("ii-img-sel");
    });
  }

  /* ---------- textarea 版：正文里的一行 ![名称](引用) ----------
     会话 / 助手输入框是 <textarea>（不是富文本），所以内嵌图在正文里就是一行 Markdown：
     插入 = 在光标处写一行（独占一行）；显示 = 调用方按 imgLines(value) 渲染胶囊条。
     来源解析 / 落盘 / 引用口径与富文本版完全共用，行为一致：
     剪贴板截图（clipboardReadImage）与内存 Blob 交给 target.saveBase64 落盘成真文件，
     资源管理器拖入的图片有本机路径 → 直接按那个绝对路径引用（不复制文件）。 */

  /* 图行正文：`![名称](引用)`。名称里的 [ ] 会破坏语法，落盘前先剔掉 */
  function imgLineText(alt, ref) {
    const a = String(alt == null ? "" : alt).replace(/[\[\]]/g, "").trim();
    const r = String(ref == null ? "" : ref).trim();
    return "![" + a + "](" + r + ")";
  }
  /* 扫正文里的图行（纯函数）。只认「整行只有一张图」的行 —— 正文里顺口提到的
     ![](x) 不算附件，也就不会凭空多出一枚胶囊。引用部分按「整行到最后一个 )」收，
     于是带空格的 Windows 路径（C:\Users\John Doe\pic.png）也是一行合法的内嵌图。返回：
       n         第几行（1 起，胶囊上的序号与它一一对应）
       start/end 这一行在正文里的字符区间（点胶囊定位 / ✕ 删除都用它）
       alt/ref   名称与引用原文
       url       可直接显示的地址（本机绝对路径 / file:/// → file:/// URL；
                 相对引用在输入框里没有基准目录 → 空串，胶囊只显示图标与文件名） */
  function imgLines(text) {
    const src = String(text == null ? "" : text);
    const out = [];
    const lines = src.split("\n");
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const m = /^[ \t]*!\[([^\]]*)\]\(\s*(.*?)\s*\)[ \t]*$/.exec(raw);
      if (m) {
        const ref = m[2].replace(/^<|>$/g, "");
        const abs = /^(?:[a-z][a-z0-9+.-]*:\/\/|data:|[a-zA-Z]:[\\/]|\\\\|\/)/i.test(ref);
        out.push({
          n: i + 1,
          start: off,
          end: off + raw.length,
          alt: m[1],
          ref: ref,
          url: abs ? fileUrl(ref) : "",
        });
      }
      off += raw.length + 1;
    }
    return out;
  }
  /* 图行的引用 → 本机绝对路径（运行链下发给网关时只能给真路径）：
     file:///C:/x.png → C:/x.png（网关 attachImages 只 readFileSync 本机文件）；
     相对引用 / data: / http(s) 一律回空串（没有基准目录、或根本不是本机文件）。 */
  function localPathOfRef(ref) {
    let s = String(ref == null ? "" : ref).trim();
    if (!s || /^data:/i.test(s) || /^https?:/i.test(s)) return "";
    if (/^file:\/\//i.test(s)) {
      s = s.replace(/^file:\/\//i, "");
      if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
      try {
        s = decodeURIComponent(s);
      } catch (_) {}
    }
    return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(s) ? s : "";
  }
  /* 正文里所有内嵌图的**本机绝对路径**（纯函数，按出现顺序去重）。
     运行链拿它当「这一轮的图像附件」下发给网关（见 renderer/app-db.js 的 dshRunImages：
     正文里的图行 → 网关 attachImages → 用户消息的 image 内容块）。 */
  function absImgPaths(text) {
    const out = [];
    const seen = new Set();
    for (const l of imgLines(text)) {
      const p = localPathOfRef(l.ref);
      if (!p) continue;
      /* 同一张图在正文里写两遍（盘符大小写 / 斜杠 / file:/// 不同写法）只下发一次 */
      const key = normImgPath(p);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }
  /* 在光标处插入一行（textarea 版 insertAtCaret）：整行独占，前后该补换行就补；
     插完光标落到这一行之后，连着粘贴好几张图不会挤成一行。 */
  function insertLineAtCaret(ta, line) {
    if (!ta || !line) return false;
    const v = String(ta.value || "");
    let s = Number(ta.selectionStart);
    let e = Number(ta.selectionEnd);
    if (!isFinite(s) || s < 0) s = v.length;
    if (!isFinite(e) || e < s) e = s;
    const before = v.slice(0, s);
    const after = v.slice(e);
    let text = String(line);
    if (before && !/\n$/.test(before)) text = "\n" + text;
    if (after && !/^\n/.test(after)) text = text + "\n";
    ta.value = before + text + after;
    const caret = before.length + text.length;
    try {
      ta.setSelectionRange(caret, caret);
    } catch (_) {}
    try {
      ta.focus();
    } catch (_) {}
    return true;
  }
  /* 插入一行图行 + 收尾回调（与富文本版 insertImgRich 同形） */
  function insertImgLine(ta, saved, opts) {
    if (!ta || !saved) return false;
    if (!insertLineAtCaret(ta, imgLineText(saved.alt, saved.rel))) return false;
    inserted(opts, saved);
    return true;
  }
  /* 图片 Blob → base64 → 落盘 → 插一行 */
  async function insertFromBlobLine(file, ta, opts) {
    const picked = await blobToPicked(file);
    if (!picked) return null;
    const saved = await saveImage(picked, targetOf(opts));
    if (saved) insertImgLine(ta, saved, opts);
    return saved;
  }
  /* 已有本机路径的图片文件：整路径落盘（不复制文件）→ 插一行 */
  function insertFromPathLine(p, ta, opts) {
    return saveImage({ srcPath: p, name: baseName(p), ext: extOf(p) }, targetOf(opts)).then(
      (saved) => {
        if (saved) insertImgLine(ta, saved, opts);
        return saved;
      },
    );
  }
  /* 主进程剪贴板位图（含截屏）→ 落盘 → 插一行 */
  function insertFromClipboardLine(ta, opts) {
    const a = window.api;
    if (!a || typeof a.clipboardReadImage !== "function") return;
    Promise.resolve(a.clipboardReadImage()).then(
      (r) => {
        if (!r || !r.ok) {
          toastMsg(T("剪贴板里没有图片"), "warn");
          return;
        }
        return saveImage(
          { base64: r.base64, name: "screenshot", ext: ".png" },
          targetOf(opts),
        ).then((saved) => {
          if (saved) insertImgLine(ta, saved, opts);
        });
      },
      () => {},
    );
  }
  /* 粘贴：图片文件项 / 内存位图（截图）→ 插一行；纯文本粘贴一律不拦截 */
  function handlePasteLine(ev, ta, opts) {
    if (!canEdit(opts)) return;
    const dt = ev.clipboardData;
    const file = imageFileIn(dt);
    if (file) {
      ev.preventDefault();
      insertFromBlobLine(file, ta, opts);
      return;
    }
    if (isBareImagePaste(dt)) {
      ev.preventDefault();
      insertFromClipboardLine(ta, opts);
    }
  }
  /* 拖入：本机图片文件走绝对路径；一次拖多张逐张插成多行（一张失败即停，不半途乱插） */
  async function handleDropLine(ev, ta, opts) {
    if (!canEdit(opts)) return;
    const files = imageFilesIn(ev.dataTransfer);
    if (!files.length) return;
    ev.preventDefault();
    for (const f of files) {
      const p = pathOfFile(f);
      const saved = p
        ? await insertFromPathLine(p, ta, opts)
        : await insertFromBlobLine(f, ta, opts);
      if (!saved) break;
    }
  }
  /* 给 textarea 一次性接好：paste / dragover / drop + input 回调（onChanged）。
     幂等 —— 调用方每轮刷新时重复调用没有副作用。 */
  function bindTextarea(ta, opts) {
    if (!ta || !ta.addEventListener || ta._iiLineBound) return;
    ta._iiLineBound = true;
    ta.classList.add("ii-line-input");
    ta.addEventListener("paste", (ev) => handlePasteLine(ev, ta, opts));
    ta.addEventListener("dragover", (ev) => {
      const dt = ev.dataTransfer;
      if (dt && Array.from(dt.types || []).indexOf("Files") >= 0) {
        ev.preventDefault();
        dt.dropEffect = "copy";
      }
    });
    ta.addEventListener("drop", (ev) => handleDropLine(ev, ta, opts));
    ta.addEventListener("input", () => {
      const f = opts && opts.onChanged;
      if (typeof f === "function") {
        try {
          f();
        } catch (_) {}
      }
    });
  }

  /* ---------- 插图小对话框：选择本机图片文件 / 从剪贴板粘贴（截图） ----------
     返回 Promise<{srcPath|base64,name,ext}|null>；两张按钮点下即取图并关闭。 */
  function pickImage(target) {
    const tg = typeof target === "function" ? target() : target || null;
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      try {
        mtDialogForm({
          title: T("插入图片"),
          msg:
            tg && tg.kind === "fact"
              ? T("图片会复制到事实库的 assets 目录，正文以相对路径引用")
              : T("图片以本机绝对路径引用"),
          custom: (c, select) => {
            const wrap = document.createElement("div");
            wrap.className = "ii-pick-btns";
            const mk = (label, hint, fn) => {
              const b = document.createElement("button");
              b.type = "button";
              b.className = "ii-img-pick";
              const t = document.createElement("b");
              t.textContent = label;
              b.appendChild(t);
              if (hint) {
                const h = document.createElement("span");
                h.textContent = hint;
                b.appendChild(h);
              }
              b.onclick = () => fn(select);
              wrap.appendChild(b);
            };
            mk(
              T("选择图片文件…"),
              T("从本机选择 png / jpg / webp / gif / bmp"),
              async (sel) => {
                const r = await window.api.fileOpenDialog({
                  title: T("选择图片"),
                  filters: [
                    {
                      name: T("图像"),
                      extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
                    },
                    { name: T("全部文件"), extensions: ["*"] },
                  ],
                });
                const p = (r && r.path) || "";
                if (!p) return;
                sel({ srcPath: p, name: baseName(p), ext: extOf(p) });
              },
            );
            mk(
              T("从剪贴板粘贴（截图）"),
              T("复制图片或截图后点这里"),
              async (sel) => {
                const r = await window.api.clipboardReadImage();
                if (!r || !r.ok) {
                  toastMsg(T("剪贴板里没有图片"), "warn");
                  return;
                }
                sel({ base64: r.base64, name: "screenshot", ext: ".png" });
              },
            );
            c.appendChild(wrap);
          },
          actions: [{ id: "cancel", label: T("取消") }],
        }).then(
          (res) => fin(res && res.custom ? res.custom : null),
          () => fin(null),
        );
      } catch (_) {
        fin(null);
      }
    });
  }

  /* ---------- 纯函数：从若干版本文本收集被引用的图片（原始引用 + 文件名两种形态）。
     GC 与测试共用，保证「任一留存版本引用到的文件都不删」。 */
  function collectImgRefs(texts) {
    const refs = new Set();
    for (const t of texts || []) {
      const s0 = String(t || "");
      const re = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
      let m;
      while ((m = re.exec(s0))) {
        const s = m[1].replace(/^<|>$/g, "").replace(/\\/g, "/");
        refs.add(s);
        const i = s.lastIndexOf("/");
        refs.add(i >= 0 ? s.slice(i + 1) : s);
      }
    }
    return refs;
  }

  /* ---------- 无引用回收 ---------- */
  /* 收集库内「所有文档 · 全部版本」引用的图片：
     · 当前文档用 target.refTexts（内存版本链，可能含尚未落盘的编辑，比 sidecar 新）；
     · 其它文档读各自 sidecar 的 versions；
     · 每篇文档的 md 正文也计入（无 sidecar / 手改 md 的引用同样不误删）。 */
  async function collectLibImgRefs(target, filesApi) {
    const tg = targetOf(target) || {};
    const lib = tg.lib || null;
    const texts = [];
    const cur = typeof tg.refTexts === "function" ? tg.refTexts() : null;
    if (Array.isArray(cur)) for (const v of cur) texts.push(v);
    const skip = String(tg.skipSidecar || "")
      .replace(/\\/g, "/")
      .toLowerCase();
    const dir = String(tg.dir || "");
    let list = [];
    if (dir) {
      try {
        const r = await filesApi.fileListDir(dir);
        list = (r && r.ok && r.list) || [];
      } catch (_) {
        list = [];
      }
    }
    for (const f of list) {
      if (!f || f.isDir) continue;
      const rel = String(f.rel || f.name || "");
      const low = rel.toLowerCase();
      const isReview = low.endsWith(".review.json");
      if (!isReview && !low.endsWith(".md")) continue;
      const abs = lib.joinPath(dir, rel);
      if (isReview) {
        /* 当前文档的 sidecar 可能落后于内存 → 用 refTexts，跳过磁盘上的这份 */
        if (abs.replace(/\\/g, "/").toLowerCase() === skip) continue;
        let d = null;
        try {
          d = await lib.readReview({ reviewFile: abs });
        } catch (_) {}
        if (d && Array.isArray(d.versions))
          for (const v of d.versions) texts.push(v && v.text);
      } else {
        let r2 = null;
        try {
          r2 = await lib.readDoc({ file: abs });
        } catch (_) {}
        if (r2 && r2.content) texts.push(r2.content);
      }
    }
    return collectImgRefs(texts);
  }
  /* 立即回收一轮：assets/ 是库级共享目录，只有库内全部文档全部版本都不引用的才删。 */
  async function runGc(target) {
    const tg = targetOf(target);
    if (!tg || tg.kind !== "fact") return;
    if (!tg.assetsDir || !tg.lib || typeof tg.refTexts !== "function") return;
    const ready =
      typeof tg.ready === "function" ? !!tg.ready() : Array.isArray(tg.refTexts());
    if (!ready) return; /* 目标文档尚未就绪 → 不做回收，避免把在用图片误判为孤立 */
    const lib = tg.lib;
    const assetsDir = String(tg.assetsDir);
    const a = window.api;
    if (!a || typeof a.fileListDir !== "function" || typeof a.factDeleteImages !== "function")
      return;
    const refs = await collectLibImgRefs(tg, a);
    let list = [];
    try {
      const r = await a.fileListDir(assetsDir);
      list = (r && r.ok && r.list) || [];
    } catch (_) {
      return;
    }
    const orphans = [];
    for (const f of list) {
      if (!f || f.isDir) continue;
      const rel = String(f.rel || f.name || "").replace(/\\/g, "/");
      const i = rel.lastIndexOf("/");
      const base = i >= 0 ? rel.slice(i + 1) : rel;
      if (refs.has(rel) || refs.has("assets/" + rel) || refs.has(base)) continue;
      orphans.push(lib.joinPath(assetsDir, rel));
    }
    if (!orphans.length) return;
    try {
      const d = await a.factDeleteImages(orphans);
      const removed = (d && d.removed) || [];
      if (removed.length)
        toastMsg(T("已从磁盘删除 ") + removed.length + T(" 个无引用图片"), "ok");
    } catch (_) {}
  }
  /* 去抖回收（插入图片 / 回滚版本后调用）：300ms 内多次触达只跑一轮。
     传函数 = 目标在触发那一刻现取（切换文档 / 版本后不会误用旧目标）。 */
  let _gcTimer = null;
  function gcOrphanImages(target) {
    const tg = targetOf(target);
    if (!tg || tg.kind !== "fact") return;
    if (_gcTimer) clearTimeout(_gcTimer);
    const getter = typeof target === "function" ? target : () => target;
    _gcTimer = setTimeout(() => {
      _gcTimer = null;
      runGc(getter());
    }, 300);
  }

  /* ═══════════ 引用集合与无引用回收（画布资产目录 / 输入框落盘目录共用） ═══════════
     两条硬规矩（下面所有函数都按它们来）：
     1) 只回收「本功能自己创建的图」——
        · 画布侧：落盘那一刻登记的台账（wf.inlineAssets）+ 节点登记表（node.inlineImgs）；
        · 输入框 / 草稿框侧：本功能自己的落盘目录（<工作区>/.mtnode-input/、数据目录
          chat-input / devnode-input）里、本功能自己命名的图（paste-<时间戳36进制>.<ext>）。
        用户自己的图片（从资源管理器拖入 = 按绝对路径引用那条原文件）、素材库 / 生成节点 /
        save 节点落在别处的产物，从头到尾都不进候选集，所以永不被本功能删。
     2) 「已引用」= 现存的每一处引用：画布节点任何字段里的图像路径（input_image / 生成节点 /
        save 节点 / 结果面板…）、正文里真的还写着 token 的内嵌图、全部会话的消息与草稿、
        输入框的当前正文。任一处在用 → 保留。
     于是删除判据是「本功能创建 ∧ 一处引用都没有」，不是「文件名像不像我们的」。 */

  /* 图像扩展名（引用判定与白名单同源） */
  const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
  /* 画布内嵌图在资产目录里的文件名前缀：app.js 落盘（savePromptCapsuleImage）与本模块同源 */
  const CANVAS_IMG_PREFIX = "pc_";
  /* 输入框 / 草稿框内嵌图的落盘目录名（app-assist.js 的 chatImgDirFor、
     app-devnode.js 的 devEmbedImgDir 同一条口径） */
  const CHAT_IMG_DIRS = [".mtnode-input", "chat-input", "devnode-input"];
  /* 本功能给「没有本机路径的图」（剪贴板截图 / 内存 Blob 落盘）的命名 */
  const CHAT_IMG_NAME_RE = /^paste-[0-9a-z]+\.(png|jpe?g|webp|gif|bmp)$/i;

  /* 比较用的路径键：file:/// → 本机路径、反斜杠 → 正斜杠、Windows 大小写折叠。
     只用于比较；删盘交出去的仍是原始路径。 */
  function normImgPath(p) {
    let s = String(p == null ? "" : p).trim();
    if (!s) return "";
    if (/^file:\/\//i.test(s)) {
      s = s.replace(/^file:\/\//i, "");
      if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
      try {
        s = decodeURIComponent(s);
      } catch (_) {}
    }
    return s.replace(/\\/g, "/").toLowerCase();
  }
  /* 绝对路径 + 图像扩展名 = 一条「图像文件引用」（相对路径没有基准目录，不参与判定） */
  function isAbsImgPath(s) {
    const t = String(s == null ? "" : s).trim();
    if (!t || t.length > 400 || !IMG_EXT_RE.test(t)) return false;
    if (/^file:\/\/[a-zA-Z]:/i.test(t)) return true;
    return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(t);
  }
  /* 一段文本里的图像引用（纯函数）：
     · 整行图行（允许路径里有空格，如 C:\Users\John Doe\a.png）+ 行内提到的 ![](x)；
     · file:/// 图片 URL（归一成本机路径，与图行同一去处）；
     · 裸绝对路径（节点结果 / 路径字段里直接写着一条本机路径，同样算「在用」；
       前面一位不能再是字母 / 数字 / 下划线 —— 否则 file:/ 里的 e:/ 会被当成盘符）。
     同一张图在正文里写两遍只算一条（按归一化路径去重，保序）。 */
  function imgRefsOfText(text) {
    const s = String(text == null ? "" : text);
    const out = [];
    if (!s) return out;
    const take = (ref) => {
      const p = localPathOfRef(ref);
      if (p) out.push(p);
      else if (/^file:\/\//i.test(String(ref || "").trim())) out.push(String(ref).trim());
    };
    for (const l of imgLines(s)) take(l.ref);
    const FILE_URL_RE = /file:\/\/\/?[^\s"'<>|?*)\]]+\.(?:png|jpe?g|webp|gif|bmp)/gi;
    const re = /!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g;
    let m;
    while ((m = re.exec(s))) take(m[1]);
    while ((m = FILE_URL_RE.exec(s))) take(m[0]);
    /* 裸路径扫描前把 file:/// URL 抹掉：它的路径段会被错认成「/ 开头的绝对路径」 */
    const masked = s.replace(FILE_URL_RE, " ");
    const re2 = /(?<![A-Za-z0-9_])(?:[a-zA-Z]:[\\/]|\\\\|\/)[^\s"'<>|?*\n]+?\.(?:png|jpe?g|webp|gif|bmp)/gi;
    while ((m = re2.exec(masked))) out.push(m[0]);
    const seen = new Set();
    const uniq = [];
    for (const p of out) {
      const k = normImgPath(p);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      uniq.push(p);
    }
    return uniq;
  }
  /* 从任意值里递归收集图像引用（纯函数）：字符串走 imgRefsOfText，数组 / 对象逐项递归。
     opts.skipKeys 里的键整枝跳过（画布侧用它排除 node.inlineImgs —— 登记表是「发过这张图」
     的账，不是「现在还在用」的引用，否则从框里删掉的图永远退不了休）。
     返回保序、按归一化路径去重。 */
  function imgRefsIn(value, opts) {
    const o = opts || {};
    const skip = new Set((o.skipKeys || []).map(String));
    const out = [];
    const seenObj = new Set();
    const walk = (v, depth) => {
      if (v == null) return;
      if (typeof v === "string") {
        for (const p of imgRefsOfText(v)) out.push(p);
        return;
      }
      if (typeof v !== "object" || depth > 12) return;
      if (seenObj.has(v)) return;
      seenObj.add(v);
      if (Array.isArray(v)) {
        for (const it of v) walk(it, depth + 1);
        return;
      }
      for (const k of Object.keys(v)) {
        if (skip.has(k)) continue;
        let val = null;
        try {
          val = v[k];
        } catch (_) {
          continue;
        }
        walk(val, depth + 1);
      }
    };
    walk(value, 0);
    const seen = new Set();
    const uniq = [];
    for (const p of out) {
      const n = normImgPath(p);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      uniq.push(p);
    }
    return uniq;
  }
  /* 纯函数：候选（本功能创建的图）里哪些一处引用都没有 —— 保序、去重、按归一化路径比对 */
  function orphanImages(candidates, refs) {
    const used = new Set();
    for (const r of refs || []) {
      const n = normImgPath(r);
      if (n) used.add(n);
    }
    const seen = new Set();
    const out = [];
    for (const c of candidates || []) {
      const raw = String(c == null ? "" : c).trim();
      if (!raw) continue;
      const n = normImgPath(raw);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      if (!used.has(n)) out.push(raw);
    }
    return out;
  }
  /* 可回收的「输入框 / 草稿框内嵌图」：目录与文件名两条件同时满足。
     用户手动放进这些目录里的图、或本机别处的图片，不合规即出局（永不被删）。 */
  function isChatInputImage(p) {
    const raw = String(p == null ? "" : p).trim();
    if (!raw || !isAbsImgPath(raw)) return false;
    const s = raw.replace(/\\/g, "/");
    const i = s.lastIndexOf("/");
    if (i <= 0) return false;
    const dirBase = s.slice(0, i).slice(s.slice(0, i).lastIndexOf("/") + 1).toLowerCase();
    if (CHAT_IMG_DIRS.indexOf(dirBase) < 0) return false;
    return CHAT_IMG_NAME_RE.test(s.slice(i + 1));
  }
  /* 画布内嵌图的命名判据（台账 / 登记表之外的兜底核对，见 app.js 的候选集） */
  function isCanvasInlineImage(p) {
    const raw = String(p == null ? "" : p).trim();
    if (!raw || !isAbsImgPath(raw)) return false;
    return baseName(raw).toLowerCase().indexOf(CANVAS_IMG_PREFIX) === 0;
  }

  /* ---------- 出口 ---------- */
  II.baseName = baseName;
  II.extOf = extOf;
  II.fileUrl = fileUrl;
  II.rangeIn = rangeIn;
  II.restoreRange = restoreRange;
  II.placeCaretAfter = placeCaretAfter;
  II.insertAtCaret = insertAtCaret;
  II.imgHtml = imgHtml;
  II.insertImgRich = insertImgRich;
  II.insertFromPicker = insertFromPicker;
  II.insertFromBlob = insertFromBlob;
  II.insertFromPath = insertFromPath;
  II.insertFromClipboard = insertFromClipboard;
  II.handlePaste = handlePaste;
  II.handleDrop = handleDrop;
  II.bindEditor = bindEditor;
  /* textarea 版（会话 / 助手输入框）：图行文本 / 图行扫描 / 光标处插行 / 绑定 */
  II.imgLineText = imgLineText;
  II.imgLines = imgLines;
  /* 图行 → 本机绝对路径（本地文件判定）/ 一个文本里全部内嵌图路径 */
  II.localPathOfRef = localPathOfRef;
  II.absImgPaths = absImgPaths;
  II.insertLineAtCaret = insertLineAtCaret;
  II.insertImgLine = insertImgLine;
  II.insertFromBlobLine = insertFromBlobLine;
  II.insertFromPathLine = insertFromPathLine;
  II.insertFromClipboardLine = insertFromClipboardLine;
  II.handlePasteLine = handlePasteLine;
  II.handleDropLine = handleDropLine;
  II.bindTextarea = bindTextarea;
  II.imageFileIn = imageFileIn;
  II.imageFilesIn = imageFilesIn;
  II.isBareImagePaste = isBareImagePaste;
  II.pathOfFile = pathOfFile;
  II.pickImage = pickImage;
  II.saveImage = saveImage;
  /* base64 归一（裸 base64 ←→ data URL）：所有要写盘 / 要 atob 的调用方共用这一份 */
  II.stripDataUrl = stripDataUrl;
  II.base64Bytes = base64Bytes;
  II.collectImgRefs = collectImgRefs;
  II.collectLibImgRefs = collectLibImgRefs;
  II.runGc = runGc;
  II.gcOrphanImages = gcOrphanImages;
  /* 引用集合与无引用回收（画布资产 / 输入框落盘目录共用） */
  II.CANVAS_IMG_PREFIX = CANVAS_IMG_PREFIX;
  II.CHAT_IMG_DIRS = CHAT_IMG_DIRS;
  II.normImgPath = normImgPath;
  II.isAbsImgPath = isAbsImgPath;
  II.imgRefsOfText = imgRefsOfText;
  II.imgRefsIn = imgRefsIn;
  II.orphanImages = orphanImages;
  II.isChatInputImage = isChatInputImage;
  II.isCanvasInlineImage = isCanvasInlineImage;

  window.MTInlineImg = II;
})();

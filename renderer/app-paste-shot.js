"use strict";
/* ============ 文本节点里粘贴截图：图像路径 / 识图 二选一 ============
   用户口径（本会话共识）：
     · 在**文本节点正文**里粘贴一张截图（纯图，没有文字）时，弹询问窗二选一：
         ① 图像路径 —— 图先落到「画布工作目录/assets/」，正文插入 Markdown 图片语法
            `![](绝对路径)`（编辑器富文本档渲染成图、源码档看到语法；板身正文框是纯文本，
            失焦后的浏览态由 fixBoardImgs 把绝对路径换成 file:/// 才能显示）；
         ② 识图 —— 调「设置 · 默认模型」里的那一只（当前是 deepseek-flash）读图，把模型回的
            **结果本身**（不带任何前后缀 / 说明）插到光标处（替换选区）。
            询问窗里另有一格「识图提示词（可选）」：写了就按它从图里取内容（只取报错那几行 /
            转成表格 / 列出按钮…），留空则沿用通用口径（有字转写、没字描述）。
     · 询问窗不点外部关闭，Esc / ✕ = 取消本次粘贴（正文一个字不动，剪贴板内容保留）；
       每次都问，不做「不再询问」的记忆。
     · 只有**纯图**粘贴才弹窗：剪贴板里同时有文字时文本优先，走原生粘贴（不抢网页 / Word 的富内容）。
     · 拖入图片不弹窗（那是另一条既有行为，见 renderer/app-inline-img.js 的 bindEditor）。
     · 识图失败（没设默认模型 / 调用报错 / 返回空）只弹一句错误提示，正文不改。

   生效面：文本节点板身正文框（buildBody 的 input_text 分支 → bindBoardTextarea）、
   Markdown 编辑器正文区两档（源码档 → bindEditorSource、富文本档 → bindEditorRich）。
   proc_text 提示词框与 input_form 描述框不在范围内。

   识图为什么要先落一个临时文件：主进程 buildRequestSpec 的 images 只认**本机文件路径**
   （读盘 → 压缩 → 内联成 data URL），没有「直接发 base64」的入口。临时文件写进画布工作目录
   下的 .mtnode-input/（与会话粘贴图同一处，由工作目录清理面板统一回收；画布还没有工作目录时
   才退回老路 <数据目录>/assets/<wfId>/）。
*/
(function () {
  if (window.MTPasteShot) return;
  const T = (s, vars) =>
    window.I18n && typeof I18n.t === "function" ? I18n.t(s, vars) : String(s || "");

  /* 识图提示词：**可补充**（本功能的询问窗里有一格「识图提示词（可选）」，
     extra 就是用户写的那句 —— 指示要从图里取什么内容）。
     · 没写 extra：老口径不变，有字逐字转写并保留版面结构，没字才描述画面；
     · 写了 extra：按它取内容（与默认的转写 / 描述规则冲突时以它为准），图上没有就如实说。
     末句是硬口径（与 app-input-form.js 的 visionPromptDefault 同源）：图已随消息发过去，
     不许模型去找文件 / 读磁盘 / 调工具 —— 否则它会先满盘找图，慢且不可控。 */
  const VISION_PROMPT_HEAD = "只输出结果本身：不要任何前缀、后缀、说明或客套，也不要重复我的要求。";
  const VISION_PROMPT_TAIL =
    "图像已随本消息一起发给你：直接看图作答，不要去找图片文件、不要读取磁盘、不要调用任何工具。";
  function visionPrompt(extra) {
    const want = String(extra || "").trim();
    const lines = [VISION_PROMPT_HEAD];
    if (want) {
      lines.push("这次按下面的要求从图里取内容（与默认的转写 / 描述规则冲突时以它为准）：");
      lines.push(want);
      lines.push("图上确实没有这里要的内容时，只回一句「图中没有」，不要编造。");
    } else {
      lines.push(
        "图中有可读文字时：逐字转写出来，并保留版面结构（表格转成 Markdown 表格、代码放进 ``` 代码块、列表保持列表）。",
      );
      lines.push("图中没有可读文字时：改写成一段中文画面描述（主体 / 构图 / 关键细节），只输出描述正文。");
    }
    lines.push(VISION_PROMPT_TAIL);
    return lines.join("\n");
  }

  /* 正在处理粘贴的元素（询问窗 + 识图期间）：同一处重复粘贴不重复触发，避免叠出多次模型调用 */
  const BUSY = new WeakSet();

  function imgMod() {
    return window.MTInlineImg || null;
  }
  function toastMsg(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind || "warn");
    } catch (_) {}
  }
  function toastErr(e) {
    const msg = String((e && e.message) || e || "").trim();
    if (msg) toastMsg(msg, "err");
  }
  /* 本机路径 → file:/// URL（唯一真源 = app.js 的 mediaFileUrlOf） */
  function fileUrlOf(p) {
    try {
      if (typeof mediaFileUrlOf === "function") return String(mediaFileUrlOf(p) || "");
    } catch (_) {}
    return "";
  }
  function isAbsLocal(p) {
    const s = String(p || "").trim();
    return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\/(?!\/)/.test(s);
  }
  function hasScheme(p) {
    const s = String(p || "").trim();
    /* 盘符（C:/、D:\）不是 URL scheme：先认出来，否则 fixBoardImgs 会把本机路径当成
       「已经有协议」而跳过换 file:///（图永远不显示） */
    if (/^[a-zA-Z]:[\\/]/.test(s)) return false;
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s);
  }

  /* ---------------- 剪贴板取图 ---------------- */
  /* 同步判定：这一下粘贴是不是「纯图」。返回
       { file }  剪贴板里就是一张图片文件（浏览器 / 资源管理器复制的图）
       { bare }  没有任何文件项、也没有文字（多为 Win+Shift+S 截图）→ 走主进程位图
       null      交给原生粘贴（有文字 / 有非图片文件 / 什么也没有） */
  function shotIn(dt) {
    if (!dt) return null;
    const types = Array.from(dt.types || []);
    /* 文本优先：网页 / Word 复制过来的富内容里往往同时带一张图，抢过来会毁掉原生粘贴 */
    if (types.some((t) => /^text\//i.test(t) || t === "text")) return null;
    const m = imgMod();
    if (m && typeof m.imageFileIn === "function") {
      const f = m.imageFileIn(dt);
      if (f) return { file: f };
    }
    const hasFiles = types.indexOf("Files") >= 0;
    if (hasFiles) return null; /* 复制的是非图片文件 → 原生粘贴 */
    return { bare: true };
  }
  /* File → { base64, name, ext }（裸 base64：落盘那一路不认 data URL 前缀） */
  function pickedFromFile(file) {
    return new Promise((resolve) => {
      const rd = new FileReader();
      rd.onload = () => {
        const dataUrl = String(rd.result || "");
        if (!dataUrl) return resolve(null);
        const m = /^data:([^;,]+)/i.exec(dataUrl);
        const mime = (m && m[1]) || "image/png";
        const m2 = imgMod();
        const b64 =
          m2 && typeof m2.stripDataUrl === "function"
            ? m2.stripDataUrl(dataUrl)
            : dataUrl.replace(/^data:[^,]*,/, "");
        resolve({
          base64: b64,
          name: String((file && file.name) || "screenshot"),
          ext: "." + mime.replace(/^image\//i, "").replace(/^jpeg$/i, "jpg"),
        });
      };
      rd.onerror = () => resolve(null);
      try {
        rd.readAsDataURL(file);
      } catch (_) {
        resolve(null);
      }
    });
  }
  async function readShot(shot) {
    if (shot && shot.file) return pickedFromFile(shot.file);
    const api = window.api;
    if (!api || typeof api.clipboardReadImage !== "function") return null;
    let r = null;
    try {
      r = await api.clipboardReadImage();
    } catch (_) {
      r = null;
    }
    if (!r || !r.ok) return null;
    return { base64: String(r.base64 || ""), name: "screenshot", ext: ".png" };
  }

  /* base64 → 字节（file:writeBytes 只认字节，字符串会被当 utf8 写坏）；
     先归一 data URL 前缀，剪贴板来的可能是整条 data:image/png;base64,… */
  function imgBytes(b64) {
    const raw = String(b64 || "").replace(/^data:[^,]*,/, "");
    const bin = atob(raw);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- 默认模型（设置 · 默认模型，不静默回落） ---------------- */
  function modelInfo() {
    let pick = null;
    try {
      if (typeof dshDefaultModelPick === "function") pick = dshDefaultModelPick();
    } catch (_) {
      pick = null;
    }
    return {
      ok: !!(pick && pick.ok),
      route: String((pick && pick.route) || ""),
      model: String((pick && pick.model) || ""),
      reason: String((pick && pick.reason) || ""),
    };
  }

  /* ---------------- 询问窗（二选一 + 可选识图提示词） ---------------- */
  /* 返回 { mode:"path"|"vision", extra } 或 null（取消）。
     extra = 「识图提示词」那一格（用户想从图里取什么），只对「识图」生效；路径分支忽略。
     mtDialogForm 自带 Esc 取消、点窗外不关闭（项目约定）。 */
  function askMode(modelName) {
    if (typeof mtDialogForm !== "function") return Promise.resolve({ mode: "path", extra: "" });
    const label = modelName ? T("识图（{model}）", { model: modelName }) : T("识图");
    return Promise.resolve(
      mtDialogForm({
        title: T("粘贴截图"),
        msg: T("这张截图要怎么放进正文？"),
        textarea: {
          label: T("识图提示词（可选 · 只对「识图」生效）"),
          placeholder: T(
            "要从图里取什么，例如：只取报错那几行 / 把这个表格转成表格 / 列出界面上所有按钮",
          ),
          rows: 3,
        },
        hint: T("留空 = 有字逐字转写、没字描述画面。"),
        actions: [
          { id: "path", label: T("图像路径") },
          { id: "vision", label: label, primary: true },
        ],
      }),
    )
      .then((r) => {
        const action = String((r && r.action) || "");
        if (action !== "path" && action !== "vision") return null;
        return { mode: action, extra: String((r && r.text) || "") };
      })
      .catch(() => null);
  }

  /* ---------------- 插入 ---------------- */
  /* 正文改了就让存档排队（板身正文框的 input 监听只写 node.text、不排存档；这里补一手，
     粘贴进来的内容不会因为没触发其它保存动作而丢） */
  function markDirty() {
    try {
      if (typeof scheduleSave === "function") scheduleSave();
    } catch (_) {}
  }
  /* 文本域：改 value + 还原光标 + 派发 input（走原有监听：板身正文框写 node.text、
     编辑器源码档 teCommit / tePushToNode，一个字都不另造通路）。 */
  function insertIntoTextarea(ta, text, sel) {
    if (!ta) return;
    const v = String(ta.value == null ? "" : ta.value);
    const s = sel && Number.isFinite(sel.start) ? Math.min(sel.start, v.length) : v.length;
    const e = sel && Number.isFinite(sel.end) ? Math.min(Math.max(sel.end, s), v.length) : s;
    const body = String(text == null ? "" : text);
    ta.value = v.slice(0, s) + body + v.slice(e);
    const caret = s + body.length;
    try {
      ta.setSelectionRange(caret, caret);
    } catch (_) {}
    try {
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {
      try {
        if (typeof ta.oninput === "function") ta.oninput();
      } catch (_) {}
    }
    try {
      ta.focus();
    } catch (_) {}
    markDirty();
  }
  /* 富文本：纯文本插入（转义成 HTML 片段，换行固定写 <br> —— richToMarkdown 把 <br>
     序列化成行尾两空格的硬换行，比让浏览器自己决定 div / p 更可预期）；失败才退到 insertAtCaret */
  function insertIntoRich(ed, text, range) {
    if (!ed) return;
    const m = imgMod();
    const s = String(text == null ? "" : text);
    try {
      if (m && typeof m.restoreRange === "function") m.restoreRange(range, ed);
      ed.focus();
    } catch (_) {}
    const html = s
      .split(/\r?\n/)
      .map(function (line) {
        return line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      })
      .join("<br>");
    let ok = false;
    try {
      ok = !!(document.execCommand && document.execCommand("insertHTML", false, html));
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      try {
        if (m && typeof m.insertAtCaret === "function")
          m.insertAtCaret(ed, document.createTextNode(s));
      } catch (_) {}
    }
    try {
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {}
    markDirty();
  }
  /* 富文本：插入真 <img>（src 用 file:/// 才显示，data-rv-src 存绝对路径 → 序列化回
     Markdown 时就是 `![](绝对路径)`，与源码档一字不差） */
  function insertImgIntoRich(ed, absPath, range) {
    const m = imgMod();
    if (!ed || !m || typeof m.insertAtCaret !== "function" || typeof m.imgHtml !== "function")
      return false;
    const url = fileUrlOf(absPath);
    if (!url) return false;
    try {
      if (typeof m.restoreRange === "function") m.restoreRange(range, ed);
      ed.focus();
    } catch (_) {}
    /* data-rv-src 用与 imgMarkdown 同一份写法（空格等已编码）：序列化回 Markdown 之后
       还能被 renderMarkdown 认成图片，不会退化成一行原文 */
    m.insertAtCaret(ed, m.imgHtml({ abs: url, rel: mdImgSrc(absPath), alt: "" }));
    try {
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {}
    markDirty();
    return true;
  }
  /* 正文里的图片语法：绝对路径（正斜杠，跨平台读得动）。空格 / 括号 / 尖括号 / # ? 一律
     百分号编码掉 —— **不能**用 CommonMark 的 `<…>` 包裹：全站渲染入口 renderMarkdown 是
     「先转义再解析」，`<` 到 marked 手上已经是 `&lt;`，被包起来的那一路根本认不出图片
     （表现就是正文里只剩一行 `![](<…>)` 原文、图永远不显示）。 */
  function mdImgSrc(absPath) {
    return String(absPath || "")
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .map(function (seg) {
        return seg.replace(/[ %()<>#?]/g, function (c) {
          return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
      })
      .join("/");
  }
  function imgMarkdown(absPath) {
    return "![](" + mdImgSrc(absPath) + ")";
  }
  /* 「识图中…」一行（贴在正文框后面；返回 remove） */
  function showBusy(anchor) {
    let el = null;
    try {
      el = document.createElement("div");
      el.className = "ps-busy";
      el.textContent = T("识图中…");
      el.style.cssText =
        "font-size:11px;line-height:1.5;padding:2px 4px;opacity:.75;user-select:none;";
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
    } catch (_) {
      el = null;
    }
    return {
      remove: function () {
        try {
          if (el) el.remove();
        } catch (_) {}
      },
    };
  }
  /* 没设画布工作目录：复用画布统一的工作目录闸门（与编辑器插图同一条路） */
  function requireWorkspace() {
    toastMsg(T("粘贴截图需要先设置画布工作目录：请在弹出的窗口里选一个文件夹"), "warn");
    try {
      if (typeof ensureRunWorkspace === "function") return ensureRunWorkspace(null);
    } catch (_) {}
    try {
      if (typeof chooseWorkspaceFolderDialog === "function")
        return chooseWorkspaceFolderDialog({ canvasWorkspace: true });
    } catch (_) {}
    return null;
  }

  /* ---------------- 两个分支 ---------------- */
  /* 图像路径：落到 <画布工作目录>/assets/（与编辑器插图的落盘位置同一处），
     再把 `![](绝对路径)` 插到光标处；富文本档插真图片节点。 */
  async function insertPath(picked, ctx) {
    const ws = String(typeof wfWorkspace === "function" ? wfWorkspace() || "" : "").trim();
    if (!ws) {
      requireWorkspace();
      return;
    }
    const m = imgMod();
    if (!m || typeof m.saveImage !== "function") {
      toastMsg(T("内嵌图片模块未就绪（app-inline-img.js）"), "err");
      return;
    }
    let saved = null;
    try {
      saved = await m.saveImage(picked, {
        kind: "fact",
        dir: ws,
        assetsDir:
          typeof joinPath === "function" ? joinPath(ws, "assets") : String(ws) + "\\assets",
        name: "assets",
      });
    } catch (e) {
      saved = null;
    }
    if (!saved || !saved.rel) return; /* saveImage 自己已经 toast 过失败原因 */
    const absPath =
      typeof joinPath === "function" ? joinPath(ws, String(saved.rel)) : String(saved.rel);
    if (ctx && typeof ctx.insertImage === "function") {
      if (insertImgIntoRich(ctx.anchor, absPath, ctx.range)) return;
    }
    if (ctx && typeof ctx.insertText === "function") ctx.insertText(imgMarkdown(absPath));
  }

  /* 识图：把图落成临时文件 → 用**默认模型**直接发一次多模态请求 → 只把结果插到光标处。
     不换模型、不重试别的路由（用户口径：固定当前默认模型，失败就报错）。
     extra = 询问窗里用户补充的识图提示词（空 = 老的通用转写 / 描述口径）。 */
  async function insertVision(picked, ctx, mi, extra) {
    const busy = showBusy(ctx && ctx.anchor);
    try {
      if (!mi.ok) throw new Error(mi.reason || T("默认模型不可用"));
      const api = window.api;
      if (!api || typeof api.apiCall !== "function") throw new Error(T("识图入口不可用"));
      if (typeof api.assetWriteBase64 !== "function")
        throw new Error(T("图片落盘不可用，无法识图"));
      const prov =
        typeof providerForAgentRoute === "function" ? providerForAgentRoute(mi.route) : null;
      if (!prov || !String(prov.apiKey || "").trim())
        throw new Error(
          T("默认模型「{model}」没有可用的服务商配置：请到 设置 · 默认模型 里重选。", {
            model: mi.model,
          }),
        );
      const wf = (typeof S === "object" && S && S.wf) || null;
      const baseName = "paste-shot-" + Date.now().toString(36);
      const ws = String((wf && wf.workspace) || "").trim();
      let savedPath = "";
      if (ws && typeof joinPath === "function") {
        /* 临时截图进画布工作目录的 .mtnode-input/（与会话粘贴图同一处，清理面板统一回收）；
           不进画布资产目录 —— 识图用完即弃的图不该混进真正要复用的素材里。 */
        const ext = String(picked.ext || ".png").replace(/^\.?/, ".");
        const dest = joinPath(ws, ".mtnode-input", baseName + ext);
        const wr = await api.fileWriteBytes(dest, imgBytes(picked.base64));
        if (!wr || wr.ok === false)
          throw new Error(String((wr && wr.error) || "") || T("图片落盘失败，无法识图"));
        savedPath = dest;
      } else {
        const wfId = (wf && wf.id) || "";
        const wr = await api.assetWriteBase64(wfId, baseName, picked.base64, picked.ext || ".png");
        if (!wr || !wr.ok || !wr.path)
          throw new Error(
            String((wr && wr.error) || "") || T("图片落盘失败，无法识图"),
          );
        savedPath = String(wr.path);
      }
      /* 服务商副本上钉 vision：main.js 只在 provider.vision 时才把图拼进 parts */
      const rr = await api.apiCall({
        provider: Object.assign({}, prov, { vision: true }),
        kind: "text",
        model: mi.model,
        prompt: visionPrompt(extra),
        texts: [],
        images: [savedPath],
        temperature: 0.2,
        effort: "off",
      });
      if (!rr || !rr.ok) throw new Error(String((rr && rr.error) || "") || T("识图调用失败"));
      const text = String(rr.text || "").trim();
      if (!text) throw new Error(T("模型没有返回任何内容"));
      if (ctx && typeof ctx.insertText === "function") ctx.insertText(text);
    } catch (e) {
      toastErr(e);
    } finally {
      busy.remove();
    }
  }

  async function run(shot, ctx) {
    try {
      let picked = null;
      try {
        picked = await readShot(shot);
      } catch (_) {
        picked = null;
      }
      if (!picked || !picked.base64) {
        toastMsg(T("剪贴板里没有图片"), "warn");
        return;
      }
      const mi = modelInfo();
      const pick = await askMode(mi.model);
      if (!pick) return; /* 取消：正文不动，剪贴板内容保留 */
      if (pick.mode === "path") return await insertPath(picked, ctx);
      return await insertVision(picked, ctx, mi, pick.extra);
    } catch (e) {
      toastErr(e);
    }
  }

  /* ---------------- 绑定 ---------------- */
  /* 文本节点板身正文框（textarea.n-text）：纯图粘贴 → 询问窗；插入后由 input 监听写回 node.text */
  function bindBoardTextarea(ta) {
    if (!ta || ta.__mtPasteShot) return;
    ta.__mtPasteShot = true;
    ta.addEventListener("paste", function (ev) {
      const shot = shotIn(ev.clipboardData);
      if (!shot) return;
      ev.preventDefault();
      /* 别让画布级「粘贴图片 → 建图像节点」的处理器再接手 */
      ev.stopPropagation();
      if (BUSY.has(ta)) return;
      const sel = { start: ta.selectionStart, end: ta.selectionEnd };
      BUSY.add(ta);
      const ctx = {
        anchor: ta,
        insertText: function (text) {
          insertIntoTextarea(ta, text, sel);
        },
      };
      run(shot, ctx).finally(function () {
        BUSY.delete(ta);
      });
    });
  }

  /* Markdown 编辑器 · 富文本档：必须注册在 MTMdEdit.bindRich / MTInlineImg.bindEditor 之前
     （同一元素上「先注册先跑」，stopImmediatePropagation 才挡得住它们原来的插图行为） */
  function bindEditorRich(ed) {
    if (!ed || ed.__mtPasteShot) return;
    ed.__mtPasteShot = true;
    ed.addEventListener("paste", function (ev) {
      const shot = shotIn(ev.clipboardData);
      if (!shot) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      ev.stopPropagation();
      if (BUSY.has(ed)) return;
      const m = imgMod();
      const range = m && typeof m.rangeIn === "function" ? m.rangeIn(ed) : null;
      BUSY.add(ed);
      const ctx = {
        anchor: ed,
        range: range,
        insertText: function (text) {
          insertIntoRich(ed, text, range);
        },
        insertImage: function (absPath) {
          insertImgIntoRich(ed, absPath, range);
        },
      };
      run(shot, ctx).finally(function () {
        BUSY.delete(ed);
      });
    });
  }

  /* Markdown 编辑器 · 源码档（textarea.rv-src）：与板身正文框同一条路 */
  function bindEditorSource(ta) {
    bindBoardTextarea(ta);
  }

  /* ---------------- 显示修正 ---------------- */
  /* 正文里的图片引用 → 能显示的 file:/// 地址（板身浏览态与富文本档共用这一份口径）。
     认三种写法：
       · 本机绝对路径（C:/…、\\\\server\\…、/…）
       · **相对引用**（`assets/<名>.png`）—— 编辑器插图 / 拖入 / 带文字的截图粘贴走的都是
         共享模块的 fact 落盘，正文里写的是相对工作目录的引用；不给它拼上画布工作目录，
         重新渲染（关掉再开、切节点、重启）时就只剩一个指不到的地址 → 图不显示
       · 百分号编码（%20 等）
     已经能显示的地址（http(s) / data: / file: / mtnode-thumb:）一律不碰，返回空串。 */
  function workspaceDir() {
    try {
      if (typeof wfWorkspace === "function") return String(wfWorkspace() || "").trim();
    } catch (_) {}
    return "";
  }
  function cleanRef(raw) {
    /* renderMarkdown 是「先转义再解析」：`<…>` 包裹与 `&` 到 DOM 上会留成 &lt; / &amp; */
    return String(raw == null ? "" : raw)
      .trim()
      .replace(/^&lt;|^</, "")
      .replace(/&gt;$|>$/, "")
      .replace(/&amp;/g, "&")
      .trim();
  }
  function displayableUrlOf(raw) {
    const rawS = String(raw == null ? "" : raw).trim();
    if (!rawS || hasScheme(rawS)) return "";
    const s = cleanRef(rawS);
    if (!s) return "";
    let dec = s;
    try {
      dec = decodeURIComponent(s);
    } catch (_) {
      dec = s;
    }
    if (isAbsLocal(dec)) return fileUrlOf(dec);
    const ws = workspaceDir();
    if (!ws || typeof joinPath !== "function") return "";
    return fileUrlOf(joinPath(ws, dec.replace(/^\.\//, "")));
  }

  /* 板身浏览态 / 编辑器富文本档：正文里的 `![](绝对路径 / assets 相对引用)` 渲染出来是
     <img src="E:/…"> 或 <img src="assets/…">，Chromium 都不认 —— 换成 file:/// 才显示 */
  function fixBoardImgs(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    Array.from(root.querySelectorAll("img")).forEach(function (img) {
      const raw = String(img.getAttribute("src") || "").trim();
      const url = displayableUrlOf(raw);
      if (url && url !== raw) img.setAttribute("src", url);
    });
  }
  /* 编辑器富文本渲染后：补 data-rv-src（序列化回 Markdown 时保留**原始引用**，相对引用
     因此仍可移植）+ 换成可显示的 URL */
  function fixRichImgs(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    Array.from(root.querySelectorAll("img")).forEach(function (img) {
      const raw = String(img.getAttribute("src") || "").trim();
      if (!raw || hasScheme(raw)) return;
      const url = displayableUrlOf(raw);
      if (!url) return;
      if (!img.getAttribute("data-rv-src")) img.setAttribute("data-rv-src", cleanRef(raw));
      img.setAttribute("src", url);
    });
  }

  window.MTPasteShot = {
    bindBoardTextarea: bindBoardTextarea,
    bindEditorRich: bindEditorRich,
    bindEditorSource: bindEditorSource,
    fixBoardImgs: fixBoardImgs,
    fixRichImgs: fixRichImgs,
    imgMarkdown: imgMarkdown,
    shotIn: shotIn,
  };
})();

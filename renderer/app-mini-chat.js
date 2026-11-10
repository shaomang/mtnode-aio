/* app-mini-chat.js — 快捷会话小窗的页面逻辑（renderer/mini-chat.html 专用）。
 *
 * 这只窗件的用途只有一件事：**快速对 agent 下发指令**，不是观察 agent 行为。所以正文区
 * 只放「这一条会话的最后一条 AI 回复」+ 自己刚下发的那句灰气泡，不渲染思考、工具调用与历史。
 *
 * 数据与控制全部来自主窗口渲染层（见 renderer/app-mini-chat-host.js 的中继协议）：
 *   api.state() / select(id) / newSession() / send({sessionId,text}) / stop(id) /
 *   gotoSession(id)，以及 api.onPush(state) —— 主窗每一拍把变化推过来，本页面只负责画。
 * 本文件不猜任何业务口径：忙 / 排队 / 暂停都是主窗算好后给的字面状态。
 */
(function () {
  "use strict";

  var api = window.miniChat;
  var T = function (k, fallback) {
    var d = (api && api.__dict) || {};
    return d[k] || fallback || k;
  };

  var dict = {};
  var state = null;
  var sidebarOpen = false; /* 左栏默认不显示（需求） */
  var pendingSend = false;
  var scrollAtBottom = true;
  /* 「已添加截图」这类自动消失的提示用一条定时器，下一条提示出现时先作废它 */
  var noteTimer = null;
  /* 删除会话的两段式确认（本轮需求）：第一下只「上膛」，4 秒内再点一下才真删，
     超时 / 切会话 / 状态刷新都会收回 —— 免得误触把正在跑的会话连文件一起删掉。 */
  var delArmed = false;
  var delTimer = null;
  /* 输入框上方那两枚模式开关（本轮需求 · 共识 q3/q4/q5/q7）：
     整个小窗共用一份，缺省「不拷问需求 + 热修开」，两枚互斥；真源在主进程那份
     mini-chat.json（重启仍生效），本页只负责画与点。它们**只影响本窗发出的那一轮**，
     不读也不写会话的 grill / hotfix 字段。 */
  var modes = { grill: false, hotfix: true };

  function $(id) {
    return document.getElementById(id);
  }

  /* 词条：主进程用 I18n.t 现算好一整份下发（页面不做语言判断） */
  function applyDict(d) {
    dict = d && typeof d === "object" ? d : {};
    T = function (k, fallback) {
      return dict[k] || fallback || k;
    };
    document.title = T("title", "快捷会话");
    $("mcTitle").textContent = T("title", "快捷会话");
    $("mcListBtn").title = T("list", "会话列表");
    $("mcNewBtn").title = T("newSessionHotkey", "新建会话（Ctrl + N）");
    $("mcCloseBtn").title = T("close", "关闭");
    $("mcSideHead").textContent = T("sessions", "会话");
    $("mcGotoBtn").title = T("goto", "在主窗口打开该会话");
    /* 删除按钮（本轮需求）：待确认态与默认态的键面 / tooltip 由 resetDelArm 统一画 */
    if ($("mcDelBtn")) resetDelArm();
    $("mcStopBtn").title = T("stop", "停止");
    $("mcSendBtn").textContent = T("send", "发送");
    $("mcInput").placeholder = T("placeholder", "输入指令…（Enter 发送，Shift+Enter 换行）");
    $("mcModeGrill").textContent = T("grill", "拷问需求");
    $("mcModeHotfix").textContent = T("hotfix", "热修");
    /* 末尾那块「你的指令」小字（常显）：只在有自己那句话时随整块一起出现 */
    if ($("mcUserTag")) $("mcUserTag").textContent = T("yourMsg", "你的指令");
    paintModes();
  }

  function text(el, v) {
    el.textContent = v == null ? "" : String(v);
  }

  /* ── 项目文件夹（本轮需求 · 共识 q1/q2）─────────────────────────────────
     小窗很窄，所以只显示文件夹名（`E:\dev\tools\pipeline-console` → `pipeline-console`），
     完整路径与来源放 tooltip；解析不出目录时如实写「未设置目录」，绝不编造路径。 */
  function baseName(p) {
    var s = String(p || "").replace(/[\\/]+$/, "");
    if (!s) return "";
    var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function wsName(p) {
    var s = String(p || "");
    return baseName(s) || s;
  }
  function wsTitle(p, src) {
    if (!p) return "";
    var bits = [T("wsLabel", "项目文件夹") + "：" + String(p)];
    if (src) bits.push(T("wsFrom", "来源：") + String(src));
    return bits.join("\n");
  }

  /* ── 两枚模式开关（互斥 · 整窗共用一份记忆）────────────────────────────── */
  function paintModes() {
    var g = $("mcModeGrill");
    var h = $("mcModeHotfix");
    if (!g || !h) return;
    g.classList.toggle("on", !!modes.grill);
    h.classList.toggle("on", !!modes.hotfix);
    g.setAttribute("aria-pressed", modes.grill ? "true" : "false");
    h.setAttribute("aria-pressed", modes.hotfix ? "true" : "false");
    g.title = T("grillTip", "拷问需求：开启后每轮先问清再动手（与「热修」互斥）");
    h.title = T(
      "hotfixTip",
      "热修：最快路径 —— 只在真有歧义时问一句，不写文档、不跑 smoke test（与「拷问需求」互斥）",
    );
  }
  /* 点一枚 = 打开它并关掉另一枚（共识 q5），随即落盘（共识 q4） */
  function setMode(key, on) {
    modes[key] = !!on;
    if (on) {
      if (key === "grill") modes.hotfix = false;
      else modes.grill = false;
    }
    paintModes();
    try {
      if (api && typeof api.setModes === "function")
        Promise.resolve(api.setModes({ grill: !!modes.grill, hotfix: !!modes.hotfix })).catch(
          function () {},
        );
    } catch (_) {}
  }

  /* 回复正文 → HTML：**与主窗口同一份内核**（renderer/md-render.js 的 window.MTRender，
   * app.js 的 renderMarkdown 也是它的包装）。以前这里是 textContent 直接塞原文，用户看到的
   * 就是「一坨没渲染的 markdown」，所以正文一律走这条管线：
   *   · 先转义再解析 → 正文里的 HTML 标签进不来；
   *   · 链接只放行 http(s)/mailto，点了交给系统浏览器（见 bind() 里的委托），不给窗口导航；
   *   · 内核缺席（页面脚本没加载全）时返回空串，调用方退回纯文本，绝不白屏。 */
  function replyHtml(md) {
    var R = window.MTRender;
    if (!R || typeof R.toHtml !== "function") return "";
    try {
      return String(R.toHtml(md) || "");
    } catch (_) {
      return "";
    }
  }

  /* ── 粘贴截图（本轮需求）──────────────────────────────────────────────────
     口径（与用户共识一一对应）：
       · 唯一的入口是**粘贴**（Ctrl+V）：小窗不接文件拖入、也不做「选图」按钮；
       · 图的形态与主窗口输入框完全同源 —— 正文里一行 `![截图](绝对路径)`，
         发送时由主窗那套 dshRunImages → 网关 attachImages 抽出来，模型真的「看见」这张图；
       · 落盘不在这里算：base64 交主窗渲染层（app-mini-chat-host.js 的 attachImage），
         目录与命名（会话工作区 .mtnode-input/paste-<36进制>.<ext>）由它在唯一真源处决定；
       · 图上限与主窗一致（不设上限）；
       · 没有选中会话：只提示，不落盘、不插行。
     呈现有两处：发送前 = 输入区上方一条缩略图胶囊（✕ 删整行）；发送后 = 「你的指令」
     气泡里把图行渲染成缩略图（点一下交系统看图程序，见 mini-chat-window.js 的 openImage）。 */
  var IMG_LINE_RE = /^!\[([^\]]*)\]\(([^)\r\n]+)\)[ \t]*$/;
  var IMG_EXT_BY_TYPE = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
  };

  function baseNameOf(p) {
    var s = String(p || "").replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  /* 正文里的图行 → [{n, alt, ref, start, end}]（n = 行号，与胶囊上那枚 #n 一一对应） */
  function imgLinesOf(v) {
    var out = [];
    var lines = String(v || "").split("\n");
    var pos = 0;
    for (var i = 0; i < lines.length; i++) {
      var raw = String(lines[i] || "").replace(/\r$/, "");
      var m = IMG_LINE_RE.exec(raw);
      if (m) out.push({ n: i + 1, alt: String(m[1] || ""), ref: String(m[2] || ""), start: pos, end: pos + raw.length });
      pos += lines[i].length + 1;
    }
    return out;
  }
  /* 本机绝对路径 → 页面能显示的 URL（本页是 file: 页面，CSP 里 img-src 放行了 file:）。
     相对引用没有基准目录 → 回空串，调用方退回图标，绝不写一个加载不出来的 src。 */
  function fileUrlOf(p) {
    var s = String(p || "").trim();
    if (!s) return "";
    if (/^(file:\/\/|data:|https?:|blob:)/i.test(s)) return s;
    var norm = s.replace(/\\/g, "/");
    if (!/^[a-zA-Z]:\//.test(norm) && norm.charAt(0) !== "/") return "";
    return "file:///" + encodeURI(norm).replace(/#/g, "%23").replace(/\?/g, "%3F");
  }
  function sessionIdNow() {
    return state && state.selectedId ? String(state.selectedId) : "";
  }
  /* 在光标处插一行图（独占一行，插完光标落到下一行）——与主窗插图的正文形态一致 */
  function insertImgLine(ta, alt, ref) {
    var v = String(ta.value || "");
    var s = typeof ta.selectionStart === "number" ? ta.selectionStart : v.length;
    var e = typeof ta.selectionEnd === "number" ? ta.selectionEnd : s;
    if (e < s) {
      var tmp = s;
      s = e;
      e = tmp;
    }
    var before = v.slice(0, s);
    var after = v.slice(e);
    var line = "![" + String(alt || "") + "](" + String(ref || "") + ")";
    var pre = before && !/\n$/.test(before) ? "\n" : "";
    var post = after && /^\n/.test(after) ? "" : "\n";
    var ins = pre + line + post;
    ta.value = before + ins + after;
    var caret = (before + ins).length;
    try {
      ta.setSelectionRange(caret, caret);
    } catch (_) {}
    try {
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {}
  }
  /* ✕：删掉那一整行（连同它独占的那个换行）。按当前正文重算偏移 ——
     胶囊是按某一帧正文画的，正文变过就按 ref 重新找，绝不按旧偏移乱删。 */
  function removeImgLine(ta, l) {
    var v = String(ta.value || "");
    var lines = imgLinesOf(v);
    var hit = null;
    for (var i = 0; i < lines.length; i++)
      if (lines[i].ref === l.ref && (lines[i].start === l.start || lines[i].n === l.n)) {
        hit = lines[i];
        break;
      }
    if (!hit) for (var j = 0; j < lines.length; j++)
      if (lines[j].ref === l.ref) {
        hit = lines[j];
        break;
      }
    if (!hit) return;
    var s = hit.start;
    var e = hit.end;
    if (v.charAt(e) === "\n") e++;
    else if (s > 0 && v.charAt(s - 1) === "\n") s--;
    ta.value = v.slice(0, s) + v.slice(e);
    try {
      ta.setSelectionRange(s, s);
    } catch (_) {}
    try {
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {}
    renderImgChips();
  }
  function focusImgLine(ta, l) {
    var lines = imgLinesOf(String(ta.value || ""));
    for (var i = 0; i < lines.length; i++)
      if (lines[i].ref === l.ref) {
        try {
          ta.focus();
          ta.setSelectionRange(lines[i].start, lines[i].end);
        } catch (_) {}
        return;
      }
  }
  function openImagePath(p) {
    try {
      if (api && typeof api.openImage === "function") api.openImage(String(p || ""));
    } catch (_) {}
  }
  /* 发送前：输入区上方那条缩略图胶囊（与正文里的图行一一对应，可点定位、可 ✕ 删） */
  function renderImgChips() {
    var box = $("mcChips");
    var ta = $("mcInput");
    if (!box || !ta) return;
    var lines = imgLinesOf(ta.value);
    box.innerHTML = "";
    box.hidden = !lines.length;
    if (!lines.length) return;
    for (var i = 0; i < lines.length; i++) {
      (function (l) {
        var chip = document.createElement("div");
        chip.className = "mc-chip";
        chip.title = "#" + l.n + " · " + T("imgLineHint", "点击定位到正文里的这一行") + "\n" + l.ref;
        var url = fileUrlOf(l.ref);
        var thumb = document.createElement(url ? "img" : "span");
        thumb.className = "mc-chip-thumb";
        if (url) thumb.src = url;
        else thumb.textContent = "🖼";
        chip.appendChild(thumb);
        var nm = document.createElement("span");
        nm.className = "mc-chip-name";
        nm.textContent = l.alt || baseNameOf(l.ref) || "";
        chip.appendChild(nm);
        var x = document.createElement("button");
        x.type = "button";
        x.className = "mc-chip-x";
        x.textContent = "✕";
        x.title = T("imgDel", "删掉这张图");
        x.onclick = function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          removeImgLine(ta, l);
        };
        chip.appendChild(x);
        chip.onclick = function () {
          focusImgLine(ta, l);
        };
        box.appendChild(chip);
      })(lines[i]);
    }
  }
  /* 「你的指令」气泡：没有图行时仍旧走 textContent（与改动前逐字一致）；
     有图行时把图渲染成缩略图（路径不外露），其余文字照旧。 */
  function paintUserBody(userEl, body) {
    var txt = String(body || "");
    var lines = imgLinesOf(txt);
    if (!lines.length || typeof document.createTextNode !== "function") {
      text(userEl, txt);
      return;
    }
    userEl.textContent = "";
    var byLine = {};
    for (var i = 0; i < lines.length; i++) byLine[lines[i].n] = lines[i];
    var arr = txt.split("\n");
    var buf = [];
    function flush() {
      if (!buf.length) return;
      userEl.appendChild(document.createTextNode(buf.join("\n")));
      buf = [];
    }
    for (var k = 0; k < arr.length; k++) {
      var ln = byLine[k + 1];
      if (!ln) {
        buf.push(String(arr[k] || "").replace(/\r$/, ""));
        continue;
      }
      flush();
      userEl.appendChild(userThumb(ln));
    }
    flush();
  }
  function userThumb(l) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mc-userimg";
    btn.title = T("imgOpen", "点开看大图（系统看图程序）");
    var url = fileUrlOf(l.ref);
    var img = document.createElement(url ? "img" : "span");
    if (url) img.src = url;
    else img.textContent = "🖼";
    try {
      img.alt = l.alt || T("截图", "截图");
    } catch (_) {}
    btn.appendChild(img);
    btn.onclick = function () {
      openImagePath(l.ref);
    };
    return btn;
  }
  function extOfType(type) {
    return IMG_EXT_BY_TYPE[String(type || "").toLowerCase()] || "png";
  }
  function readBase64(file) {
    return new Promise(function (resolve) {
      try {
        var fr = new FileReader();
        fr.onload = function () {
          resolve(String(fr.result || "").replace(/^data:[^,]*,/, ""));
        };
        fr.onerror = function () {
          resolve("");
        };
        fr.readAsDataURL(file);
      } catch (_) {
        resolve("");
      }
    });
  }
  function noteShot(m) {
    note(m, true);
  }
  /* 落盘 + 插行：落哪儿由主窗渲染层决定，这里只拿回绝对路径 */
  function attachBase64(base64, ext) {
    if (!base64) {
      noteShot(T("shotFail", "截图没能存下来，再贴一次"));
      return;
    }
    var sid = sessionIdNow();
    if (!sid) {
      noteShot(T("needSession", "先新建或选一条会话，再贴截图"));
      return;
    }
    api
      .attachImage({ sessionId: sid, base64: base64, ext: ext || "png" })
      .then(function (r) {
        if (!r || r.ok === false || !r.data || !r.data.path) {
          noteShot(T("shotFail", "截图没能存下来，再贴一次"));
          return;
        }
        var ta = $("mcInput");
        if (!ta) return;
        insertImgLine(ta, r.data.alt || T("截图", "截图"), r.data.path);
        renderImgChips();
        note(T("shotAdded", "已添加截图"), false);
        noteTimer = setTimeout(function () {
          noteTimer = null;
          note("");
        }, 1600);
        ta.focus();
      })
      .catch(function () {
        noteShot(T("shotFail", "截图没能存下来，再贴一次"));
      });
  }
  /* 粘贴：有图片文件项就直接读它；既没有文字也没有文件项（多为 Win+Shift+S 截图）
     → 走主进程剪贴板位图兜底；纯文本 / 普通文件粘贴一律不拦（交回 textarea 自己处理）。 */
  function imageFileOf(dt) {
    try {
      var items = dt.items || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it && it.kind === "file" && /^image\//i.test(String(it.type || ""))) {
          var f = it.getAsFile && it.getAsFile();
          if (f) return f;
        }
      }
      var files = dt.files || [];
      for (var j = 0; j < files.length; j++)
        if (files[j] && /^image\//i.test(String(files[j].type || ""))) return files[j];
    } catch (_) {}
    return null;
  }
  function onPaste(ev) {
    var dt = ev && ev.clipboardData;
    if (!dt) return;
    var file = imageFileOf(dt);
    if (file) {
      if (ev.preventDefault) ev.preventDefault();
      readBase64(file).then(function (b64) {
        attachBase64(b64, extOfType(file.type));
      });
      return;
    }
    var hasText = false;
    var hasFiles = false;
    try {
      hasText = !!String(dt.getData ? dt.getData("text") || "" : "").trim();
    } catch (_) {}
    try {
      hasFiles = !!(dt.files && dt.files.length);
    } catch (_) {}
    if (hasText || hasFiles) return;
    if (ev.preventDefault) ev.preventDefault();
    if (!api || typeof api.clipboardImage !== "function") return;
    Promise.resolve(api.clipboardImage())
      .then(function (r) {
        if (!r || r.ok === false || !r.base64) {
          noteShot(T("shotFail", "截图没能存下来，再贴一次"));
          return;
        }
        attachBase64(String(r.base64), String(r.ext || "png"));
      })
      .catch(function () {
        noteShot(T("shotFail", "截图没能存下来，再贴一次"));
      });
  }

  /* ── 草稿（本次修复 · 用户共识 q5）───────────────────────────────────────
     关窗（Esc / ✕ / 窗内 F1）不再吃掉输入框里没发出去的字：每次输入防抖 150 ms 冲一次盘
     （主进程写 mini-chat.json，与窗口尺寸 / 两枚模式同一份文件），失焦与关窗前再立刻冲一次；
     **只有「发送成功」才清空**。下次开窗按这份草稿回填（页面只负责填，不猜任何业务口径）。 */
  var DRAFT_MS = 150;
  var draftTimer = null;

  function draftPayload() {
    var ta = $("mcInput");
    return { text: ta ? String(ta.value || "") : "", sessionId: sessionIdNow() };
  }
  /* 立刻冲一次（返回 Promise：关窗那一路要等它落地再关） */
  function saveDraftNow() {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    if (!api || typeof api.setDraft !== "function") return Promise.resolve(null);
    try {
      return Promise.resolve(api.setDraft(draftPayload())).then(
        function (r) {
          return r;
        },
        function () {
          return null;
        },
      );
    } catch (_) {
      return Promise.resolve(null);
    }
  }
  function queueDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      draftTimer = null;
      saveDraftNow();
    }, DRAFT_MS);
  }
  /* 发送成功才走这里：正文已经出去了，草稿不该再回来 */
  function clearDraft() {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    if (!api || typeof api.setDraft !== "function") return;
    try {
      Promise.resolve(api.setDraft({ text: "", sessionId: sessionIdNow() })).catch(function () {});
    } catch (_) {}
  }
  /* 关窗：先冲草稿再关（IPC 顺序保证「写」在「关」之前；主进程不应答也不许把窗口卡住） */
  function closeWithDraft() {
    if (!api) return;
    var closed = false;
    function go() {
      if (closed) return;
      closed = true;
      try {
        api.close();
      } catch (_) {}
    }
    var p = saveDraftNow();
    if (p && typeof p.then === "function") p.then(go, go);
    else go();
    setTimeout(go, 200);
  }
  /* 开机回填：只填还空着的输入框（首帧里用户已经敲了字就一个字也不许覆盖） */
  function restoreDraft() {
    if (!api || typeof api.draft !== "function") return;
    try {
      Promise.resolve(api.draft())
        .then(function (d) {
          var t = d && typeof d.text === "string" ? d.text : "";
          if (!t) return;
          var ta = $("mcInput");
          if (!ta || String(ta.value || "")) return;
          ta.value = t;
          renderImgChips();
          try {
            var n = t.length;
            ta.focus();
            ta.setSelectionRange(n, n);
          } catch (_) {}
        })
        .catch(function () {});
    } catch (_) {}
  }

  function paintPill(sel) {
    var pill = $("mcPill");
    var stop = $("mcStopBtn");
    var paused = !!(sel && sel.paused);
    var busy = !!(sel && sel.busy);
    var queued = !!(sel && sel.queued);
    var label = "";
    var cls = "mc-pill";
    if (paused) {
      label = T("paused", "已暂停");
      cls += " is-paused";
    } else if (busy) {
      label = T("running", "运行中");
    } else if (queued) {
      label = T("queued", "排队中");
      cls += " is-queued";
    }
    if (label) {
      pill.textContent = label;
      pill.className = cls;
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
    /* 停止只在真有活在跑（或暂停待续）时露出来：空闲时按它什么也不会发生 */
    stop.hidden = !(busy || queued || paused);
  }

  /* ── 折叠记忆（本轮需求）─────────────────────────────────────────────────
     只记「哪些组是折起来的」，键 = 分组键（文件夹名，与上面 renderList 的分组同口径；
     无目录组是 \u0000none）。存小窗自己的 localStorage（键前缀 mtnode.mc*，与主窗那些
     mtnode.* 键同一个 store，但互不干扰），关窗 / 重启应用后仍按上次折。
     存不进去（隐私策略 / 无 localStorage）也不影响本次开窗内的折叠 —— 一律 try 包住。 */
  var FOLD_LS = "mtnode.mcFoldedGroups";
  var folded = {};
  function loadFolded() {
    folded = {};
    try {
      var raw = (window.localStorage && localStorage.getItem(FOLD_LS)) || "";
      var arr = raw ? JSON.parse(raw) : [];
      if (Object.prototype.toString.call(arr) === "[object Array]")
        arr.forEach(function (k) {
          if (k != null && k !== "") folded[String(k)] = true;
        });
    } catch (_) {
      folded = {};
    }
  }
  function saveFolded() {
    try {
      var arr = Object.keys(folded).filter(function (k) {
        return !!folded[k];
      });
      if (window.localStorage) localStorage.setItem(FOLD_LS, JSON.stringify(arr));
    } catch (_) {}
  }
  function setFolded(gid, on) {
    if (!gid) return;
    if (on) folded[gid] = true;
    else delete folded[gid];
    saveFolded();
  }

  /* ── 左栏：按项目文件夹分组（与主窗口会话界面同口径）──────────────────────
     组标题 = `📁 文件夹名 · 条数`，会话挂在下面；行内不再重复第二行目录小字（小窗窄，
     同一条目录说两遍只会挤掉标题）。分组键与显示名都复用上面那套「只取内层文件夹名」的口径，
     没有目录的会话归入「未设置目录」组，绝不编造路径。
     组顺序 = 组内最新会话的时间倒序，组内也按新→旧（state.sessions 已由主窗按时间排好，
     这里保持到达顺序即可，不重排 —— 免得「点一下会话就跳位」）。
     本轮需求：组标题可点着折叠（▾/▸，状态跨重启记住），组标题右侧悬停出一颗小「＋」，
     点它就在**这一组的文件夹**里新建会话（未设置目录那组不给「＋」—— 造出无目录会话没意义）。
     折叠只为缩短列表，不另加下拉 / 搜索入口（用户共识 q4）。 */
  function renderList() {
    var list = $("mcList");
    list.innerHTML = "";
    var sessions = (state && state.sessions) || [];
    if (!sessions.length) {
      var none = document.createElement("div");
      none.className = "mc-empty";
      text(none, T("emptyNoSession", "还没有会话，点右上角 ＋ 新建一条"));
      list.appendChild(none);
      return;
    }
    var selId = String((state && state.selectedId) || "");
    var groups = [];
    var byKey = {};
    sessions.forEach(function (s) {
      var wsPath = String((s && s.ws) || "");
      var key = wsPath ? wsName(wsPath) : "";
      var gid = key || "\u0000none";
      if (!byKey[gid]) {
        byKey[gid] = { gid: gid, key: key, path: wsPath, src: (s && s.wsSrc) || "", items: [] };
        groups.push(byKey[gid]);
      }
      byKey[gid].items.push(s);
    });
    groups.forEach(function (g) {
      var isFolded = !!folded[g.gid];
      var gh = document.createElement("div");
      gh.className = "mc-group" + (g.path ? "" : " is-none") + (isFolded ? " is-folded" : "");
      var head = document.createElement("button");
      head.type = "button";
      head.className = "mc-group-head";
      head.setAttribute("aria-expanded", isFolded ? "false" : "true");
      var tip = isFolded ? T("unfoldGroup", "展开这一组") : T("foldGroup", "折叠这一组");
      head.title =
        tip +
        "\n" +
        (g.path
          ? wsTitle(g.path, g.src)
          : T("noWsHint", "这些会话还没解析出项目文件夹（主窗口里给它设一个工作目录即可）"));
      var chev = document.createElement("i");
      chev.className = "mc-chev";
      text(chev, isFolded ? "▸" : "▾");
      head.appendChild(chev);
      var gn = document.createElement("span");
      gn.className = "mc-group-name";
      text(gn, "📁 " + (g.path ? g.key : T("noWs", "未设置目录")) + " · " + g.items.length);
      head.appendChild(gn);
      head.onclick = function () {
        setFolded(g.gid, !isFolded);
        renderList();
      };
      gh.appendChild(head);
      if (g.path) {
        var add = document.createElement("button");
        add.type = "button";
        add.className = "mc-group-add";
        text(add, "＋");
        add.title = T("groupNew", "在这个文件夹里新建会话");
        add.setAttribute("aria-label", T("groupNew", "在这个文件夹里新建会话"));
        add.onclick = function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          newSessionInGroup(g.path);
        };
        gh.appendChild(add);
      }
      list.appendChild(gh);
      if (isFolded) return;
      g.items.forEach(function (s) {
        var row = document.createElement("div");
        row.className = "mc-item" + (String(s.id) === selId ? " is-active" : "");
        row.setAttribute("role", "listitem");
        /* 行悬停说明：标题 + 这条会话自己的目录（组标题已写文件夹名，这里给全路径与来源） */
        var wsPath = String((s && s.ws) || "");
        row.title = [s.title || "", wsPath ? wsTitle(wsPath, s.wsSrc) : T("noWs", "未设置目录")]
          .filter(Boolean)
          .join("\n");
        var dot = document.createElement("i");
        dot.className = "mc-dot";
        dot.hidden = !s.busy;
        row.appendChild(dot);
        var nm = document.createElement("span");
        nm.className = "mc-item-name";
        text(nm, s.title || T("newSession", "新会话"));
        row.appendChild(nm);
        if (s.badge) {
          var b = document.createElement("span");
          b.className = "mc-badge";
          text(b, s.badge);
          row.appendChild(b);
        }
        row.onclick = function () {
          selectSession(s.id);
        };
        list.appendChild(row);
      });
    });
  }

  /* forceBottom：发送后第一次回显时用 —— 不管用户之前滚到哪，都把视口钉到最末，
     保证「自己刚下发的那句」立刻可见（它现在是整段最后一块，见 mini-chat.html）。 */
  function renderBody(forceBottom) {
    var sel = state && state.selected;
    text($("mcSessName"), sel ? sel.title || T("newSession", "新会话") : "—");
    /* 没有选中会话时不给删除（没东西可删）：按钮跟着这一行一起显隐 */
    if ($("mcDelBtn")) $("mcDelBtn").hidden = !sel;
    /* 顶部会话栏下那一行小字：这条会话真正工作的目录（共识 q1） */
    var wsRow = $("mcWsRow");
    if (wsRow) {
      var selWs = sel && sel.ws ? String(sel.ws) : "";
      if (sel) {
        wsRow.hidden = false;
        wsRow.className = "mc-wsrow" + (selWs ? "" : " is-none");
        text(wsRow, "📁 " + (selWs ? wsName(selWs) : T("noWs", "未设置目录")));
        wsRow.title = selWs
          ? wsTitle(selWs, sel.wsSrc)
          : T("noWsHint", "这条会话还没解析出项目文件夹（主窗口里给它设一个工作目录即可）");
      } else {
        wsRow.hidden = true;
        wsRow.textContent = "";
        wsRow.title = "";
      }
    }
    paintPill(sel);
    var replyEl = $("mcReply");
    var userEl = $("mcUser");
    /* 自己那句连同「你的指令」小字一起藏在同一块里：常显（用户共识 q5），
       位置在 AI 回复之后 = 整段最末（用户共识 q1/q3）。 */
    var userTurnEl = $("mcUserTurn") || userEl;
    var emptyEl = $("mcEmpty");
    var reply = sel && sel.lastReply ? String(sel.lastReply) : "";
    var user = sel && sel.lastUser ? String(sel.lastUser) : "";
    if (user) {
      userTurnEl.hidden = false;
      /* 图行渲染成缩略图、路径不外露（本轮需求）；没有图行时与改动前逐字一致 */
      paintUserBody(userEl, user);
    } else {
      userTurnEl.hidden = true;
      userEl.textContent = "";
    }
    if (reply) {
      /* 标题 / 列表 / 代码块 / 表格 / 加粗都按 Markdown 渲染（replyHtml 已经做过 HTML 转义）。
         自己下发的那句仍是灰色纯文本气泡（见上），用户写什么就显示什么。 */
      var html = replyHtml(reply);
      if (html) replyEl.innerHTML = html;
      else text(replyEl, reply);
      emptyEl.hidden = true;
    } else {
      replyEl.textContent = "";
      emptyEl.hidden = false;
      text(
        emptyEl,
        sel
          ? sel.busy
            ? T("waiting", "正在跑，跑完这里会出现它的回复…")
            : T("emptyNoReply", "这条会话还没有回复")
          : T("emptyNoSession", "还没有会话，点右上角 ＋ 新建一条"),
      );
    }
    var scroll = $("mcScroll");
    if (forceBottom) scrollAtBottom = true;
    if (scrollAtBottom) scroll.scrollTop = scroll.scrollHeight;
    /* 输入区上方那条缩略图胶囊随正文同步（发完清空 / 切会话 / 推送回来都走这里） */
    renderImgChips();
  }

  function render(forceBottom) {
    renderList();
    renderBody(forceBottom);
    $("mcSide").hidden = !sidebarOpen;
    $("mcListBtn").setAttribute("aria-pressed", sidebarOpen ? "true" : "false");
  }

  function note(msg, warn) {
    /* 新提示一来就作废旧的那条定时清除（「已添加截图」不该盖掉随后的「已下发」） */
    if (noteTimer) {
      clearTimeout(noteTimer);
      noteTimer = null;
    }
    var el = $("mcNote");
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = "mc-note" + (warn ? " is-warn" : "");
    text(el, msg);
  }

  function errText(r) {
    var why = (r && r.error) || "";
    if (why === "main_not_ready") return T("mainNotReady", "主窗口不可用，先在主窗口打开一次");
    if (why === "timeout") return T("timeout", "主窗口没有响应，稍后再试");
    if (why === "missing") return T("sessionMissing", "这条会话已不存在");
    if (why === "empty") return T("emptyText", "先写一句指令");
    return T("failed", "操作失败");
  }

  /* 收到的这份状态是不是「比手上这份更新」。
     主窗每 800ms 推一拍，而 ＋ / 切会话 / 发送这些操作各自也会回一份状态 ——
     推送与回执是两条独立的路，先起的推送完全可能后到，把刚拿到的新状态（新会话）
     覆盖回旧会话：于是小窗标题、正文都退回上一条会话，用户接着输入的那句按
     state.selectedId 发进了**旧会话**，新会话里什么都没有，眼前只剩旧会话那条
     不相干的回复。宿主给每份快照配了单调 rev（buildState 一开跑就取号），
     这里就按它挡掉迟到的那份；老宿主不带 rev（=0）时按老口径照收，行为不劣化。 */
  function acceptState(data) {
    if (!data) return false;
    var nxt = typeof data.rev === "number" ? data.rev : 0;
    if (!nxt) return true;
    var cur = state && typeof state.rev === "number" ? state.rev : 0;
    return nxt > cur;
  }

  function applyState(r) {
    if (!r || r.ok === false || !r.data) {
      note(errText(r), true);
      return false;
    }
    /* 回的这份比手上还旧：已经被更新的一拍顶掉了，忽略即可（不算失败） */
    if (!acceptState(r.data)) return true;
    /* 换了会话就把删除按钮的「上膛」收回：待确认的对象已经不是眼前这条了 */
    var prevSel = state && state.selectedId ? String(state.selectedId) : "";
    if (prevSel !== String((r.data && r.data.selectedId) || "")) resetDelArm();
    state = r.data;
    scrollAtBottom = true;
    render();
    note("");
    return true;
  }

  function selectSession(id) {
    if (!api) return;
    api
      .select(id)
      .then(applyState)
      .catch(function () {
        note(T("failed", "操作失败"), true);
      });
  }

  function newSession() {
    if (!api) return;
    api
      .newSession()
      .then(applyState)
      .catch(function () {
        note(T("failed", "操作失败"), true);
      });
  }

  /* 组内「＋」（本轮需求）：就在这一组的文件夹里新建一条 —— 先把这一组展开（用户共识 q6：
     新建完的那条必须在眼前），再让主窗把目标目录钉给新会话（见 app-mini-chat-host.js
     的 newSession.ws）。带目录的新建必须先展开再渲染，所以展开状态在请求前就落好。 */
  function newSessionInGroup(wsPath) {
    if (!api) return;
    var ws = String(wsPath || "");
    if (!ws) {
      newSession();
      return;
    }
    setFolded(wsName(ws), false);
    api
      .newSession({ ws: ws })
      .then(function (r) {
        if (!applyState(r)) return;
        try {
          $("mcInput").focus();
        } catch (_) {}
      })
      .catch(function () {
        note(T("failed", "操作失败"), true);
      });
  }

  function send() {
    if (!api || pendingSend) return;
    var input = $("mcInput");
    var body = String(input.value || "").trim();
    var sid = state && state.selectedId ? String(state.selectedId) : "";
    if (!body) {
      note(T("emptyText", "先写一句指令"), true);
      input.focus();
      return;
    }
    if (!sid) {
      note(T("emptyNoSession", "还没有会话，点右上角 ＋ 新建一条"), true);
      return;
    }
    pendingSend = true;
    $("mcSendBtn").disabled = true;
    api
      .send({
        sessionId: sid,
        text: body,
        /* 这一轮的模式（共识 q3/q7）：只随这一轮下发，不改会话字段 */
        grill: !!modes.grill,
        hotfix: !!modes.hotfix,
      })
      .then(function (r) {
        if (!r || r.ok === false) {
          note(errText(r), true);
          return;
        }
        input.value = "";
        /* 发出去了 = 草稿使命结束（这是唯一会清草稿的地方；Esc / ✕ / F1 关窗都不清） */
        clearDraft();
        /* 乐观回显：主窗那一拍推送回来之前，先把用户这句显示出来（灰气泡）。
           它排在 AI 回复之后 = 整段最末，所以强制滚到底（用户共识 q1/q2）。 */
        if (state && state.selected) {
          state.selected.lastUser = body;
          renderBody(true);
        }
        note(T("sent", "已下发"), false);
        setTimeout(function () {
          note("");
        }, 1600);
      })
      .catch(function () {
        note(T("failed", "操作失败"), true);
      })
      .then(function () {
        pendingSend = false;
        $("mcSendBtn").disabled = false;
        input.focus();
      });
  }

  function stop() {
    if (!api) return;
    var sid = state && state.selectedId ? String(state.selectedId) : "";
    if (!sid) return;
    api
      .stop(sid)
      .then(function (r) {
        if (!r || r.ok === false) note(errText(r), true);
      })
      .catch(function () {});
  }

  function gotoSession() {
    if (!api) return;
    var sid = state && state.selectedId ? String(state.selectedId) : "";
    if (!sid) return;
    api.gotoSession(sid).catch(function () {});
  }

  /* ── 删除会话（本轮需求）────────────────────────────────────────────────
     按钮在「跳主窗」左边，两下才真删：第一下把键面换成「删掉？」（红框上膛），
     4 秒内再点一下才发请求；超时、切会话、状态刷新都自动收回。
     真删由主窗那条内核做（deleteAgentSession：摘节点关联 → 删会话文件与索引条目 → 重绘），
     小窗只递 id —— 磁盘口径不在这里另算一套。 */
  function resetDelArm() {
    if (delTimer) {
      clearTimeout(delTimer);
      delTimer = null;
    }
    delArmed = false;
    var b = $("mcDelBtn");
    if (!b) return;
    b.classList.remove("is-armed");
    b.textContent = "🗑";
    b.title = T("delSession", "删除这条会话");
  }

  function deleteSession() {
    if (!api) return;
    if (typeof api.deleteSession !== "function") {
      /* 老 preload（没重新加载过的小窗）没有这条通道：明说，不静默什么都不做 */
      note(T("failed", "操作失败"), true);
      return;
    }
    var sid = state && state.selectedId ? String(state.selectedId) : "";
    if (!sid) {
      note(T("emptyNoSession", "还没有会话，点右上角 ＋ 新建一条"), true);
      return;
    }
    var b = $("mcDelBtn");
    if (!delArmed) {
      delArmed = true;
      if (b) {
        b.classList.add("is-armed");
        b.textContent = T("delConfirmShort", "删掉？");
        b.title = T("delConfirm", "再点一下删除这条会话（连会话记录一起删掉，不可恢复）");
      }
      if (delTimer) clearTimeout(delTimer);
      delTimer = setTimeout(resetDelArm, 4000);
      return;
    }
    resetDelArm();
    api
      .deleteSession(sid)
      .then(function (r) {
        if (!r || r.ok === false) {
          note(errText(r), true);
          return;
        }
        if (r.data) {
          state = r.data;
          scrollAtBottom = true;
          render();
        }
        note(T("delDone", "会话已删除"), false);
        setTimeout(function () {
          note("");
        }, 1600);
      })
      .catch(function () {
        note(T("failed", "操作失败"), true);
      });
  }

  function bind() {
    $("mcListBtn").onclick = function () {
      sidebarOpen = !sidebarOpen;
      render();
    };
    $("mcNewBtn").onclick = newSession;
    $("mcCloseBtn").onclick = closeWithDraft;
    $("mcSendBtn").onclick = send;
    $("mcStopBtn").onclick = stop;
    $("mcGotoBtn").onclick = gotoSession;
    /* 删除这条会话（本轮需求）：两段式确认，见上面的 deleteSession */
    if ($("mcDelBtn")) $("mcDelBtn").onclick = deleteSession;
    /* 两枚模式开关：点一枚 = 打开它并关掉另一枚（互斥），随即落盘 */
    if ($("mcModeGrill"))
      $("mcModeGrill").onclick = function () {
        setMode("grill", !modes.grill);
      };
    if ($("mcModeHotfix"))
      $("mcModeHotfix").onclick = function () {
        setMode("hotfix", !modes.hotfix);
      };
    var input = $("mcInput");
    input.addEventListener("keydown", function (ev) {
      /* 中文输入法组字中的 Enter 属于选词，不是发送 */
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        send();
      }
    });
    /* 粘贴截图（本轮需求）：这里只接「图」，纯文本粘贴照旧交给 textarea 自己 */
    input.addEventListener("paste", onPaste);
    /* 正文变了就重画胶囊条（删图 / 手改图行 / 撤销都要跟上），并跟着刷新草稿 */
    input.addEventListener("input", function () {
      renderImgChips();
      queueDraft();
    });
    /* 正文里的链接（Markdown 的 [文字](https://…)）：小窗不给导航离开本页 ——
       一律拦下，http(s)/mailto 交系统默认程序打开，其余（相对路径 / file:）点了不动。 */
    var replyEl = $("mcReply");
    if (replyEl) {
      replyEl.addEventListener("click", function (ev) {
        var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
        if (!a) return;
        ev.preventDefault();
        var href = String(a.getAttribute("href") || "");
        if (!/^(https?:|mailto:)/i.test(href)) return;
        try {
          if (api && typeof api.openExternal === "function") api.openExternal(href);
        } catch (_) {}
      });
    }
    /* Esc = 关窗（与 ✕ 同一语义：销毁窗口，不做「收起」）；关之前先把草稿冲一次盘，
       下次开窗按它回填 —— 误触 Esc 不再白写一段话。 */
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeWithDraft();
        return;
      }
      /* 窗内 F1（本次修复）：焦点在小窗里时按 F1 过去**一点反应都没有** ——
         主窗 renderer/app-status-keys.js 只在主窗有焦点时才收得到这颗键。
         语义与主窗同一份（开着就关），所以这里直接走关窗那一路。 */
      if (ev.key === "F1") {
        ev.preventDefault();
        closeWithDraft();
      }
      /* Ctrl + N = 新建会话（与右上角 ＋ 同一路径）：光标在输入框里也照用，
         组合键不会往正文里塞字符。Ctrl+Shift+N / Alt 组合留给系统与别处。 */
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && !ev.isComposing) {
        var k = String(ev.key || "").toLowerCase();
        if (k === "n" || String(ev.code || "") === "KeyN") {
          ev.preventDefault();
          newSession();
        }
      }
    });
    /* 失焦 / 卸载：把草稿落定。主窗那边按 F1 关窗时，本窗已经先失焦过，
       所以「先冲一次盘」这条路径覆盖了所有不是自己关窗的关窗方式。 */
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("blur", function () {
        saveDraftNow();
      });
      window.addEventListener("beforeunload", function () {
        saveDraftNow();
      });
    }
    var scroll = $("mcScroll");
    scroll.addEventListener("scroll", function () {
      scrollAtBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24;
    });
    input.focus();
  }

  function boot() {
    if (!api) {
      /* 桥没起来（极少见：preload 缺失）—— 至少不白屏 */
      text($("mcEmpty"), "preload 桥未就绪");
      return;
    }
    /* 折叠记忆要先读回来：首次 render 就得按上次折的样子画（缺省全展开） */
    loadFolded();
    bind();
    /* 上次没发出去的草稿先回填（关窗不丢字 · 本次修复） */
    restoreDraft();
    api.i18n().then(function (r) {
      applyDict(r && r.dict);
      render();
    });
    /* 两枚模式开关的初值（缺省不拷问 + 热修开；用户改过的从主进程那份记忆读回来） */
    try {
      if (typeof api.modes === "function")
        Promise.resolve(api.modes())
          .then(function (m) {
            if (!m || typeof m !== "object") return;
            if (typeof m.grill === "boolean") modes.grill = m.grill;
            if (typeof m.hotfix === "boolean") modes.hotfix = m.hotfix;
            /* 老存档两枚都为真时按热修优先归一（与主进程写入口径一致） */
            if (modes.grill && modes.hotfix) modes.grill = false;
            paintModes();
          })
          .catch(function () {});
    } catch (_) {}
    api.hotkey().then(function (r) {
      if (r && r.ok === false)
        note(T("hotkeyFail", "F1 被其它程序占用，用左下角入口按钮打开"), true);
    });
    api.onPush(function (payload) {
      if (!payload || payload.type !== "state" || !payload.data) return;
      /* 迟到的旧快照不许把手上这份顶掉（见 acceptState：新建会话后旧会话的
         一拍后到，会把窗口与接下来的发送目标一起退回去） */
      if (!acceptState(payload.data)) return;
      var stick = scrollAtBottom;
      state = payload.data;
      scrollAtBottom = stick;
      render();
    });
    api
      .state()
      .then(applyState)
      .catch(function () {
        note(T("failed", "操作失败"), true);
      });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

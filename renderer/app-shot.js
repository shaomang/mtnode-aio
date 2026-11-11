/* 截屏标注工具 · Agent 入口（renderer 侧）
   ────────────────────────────────────────────────────────────────────────────
   网关插件 dsh/gateway/screenshot-plugin.mjs 注册了 mtnode_screenshot：Agent 说
   「帮我截个图看看」，会话就发来一帧 {t:'shot', action:'grab', params:{reason}}，
   app-db.js 收到后交给这里的 handleShotToolEvent。

   **这一层先摆一只对话框，绝不直接冻结屏幕**（本次需求）：和会话输入框一样写一句话，
   也可以填 / 选一张本机已有图片的绝对路径 ——
     · 填了路径 → 直接把那张图交回去（不拍屏、不进浮层）；
     · 只写一句话 → 这句话就是回执（Agent 不用再等一张图）；
     · 点「开始截图…」→ 才走主进程那条抢屏链路（api.shotAgent → main.js 的
       shot:agent → screenshot-overlay.js 的 request），把整块屏冻成静止的画、
       两段式浮层（框选 → 裁剪图上标注），完成后回 { ok, path, markdown, notes, width, height }。

   回执一律走 dshInteract kind:'shot'（与 canvas / db / facts / asset 同一契约）：
   工具以正常结果收场，会话不中断 —— 用户不想截图不是错误。 */
(function () {
  "use strict";

  const T = (s, vars) =>
    window.I18n && typeof I18n.t === "function" ? I18n.t(s, vars) : String(s == null ? "" : s);

  const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
  const IMG_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

  /* 交给网关的那份结果：只挑白名单字段，别把宿主内部对象整包抖出去。
     text = 用户在对话框里写的那句话；supplied = 这张图是用户给的路径（不是本次截的）。
     这两个字段**只有真有值才带上**，回执形状对老调用方保持不变。 */
  function toolResult(r) {
    const v = r && typeof r === "object" ? r : {};
    const notes = Array.isArray(v.notes)
      ? v.notes.map((n) => ({
          n: Number(n && n.n) || 0,
          kind: String((n && n.kind) || ""),
          x: Number(n && n.x) || 0,
          y: Number(n && n.y) || 0,
          w: Number(n && n.w) || 0,
          h: Number(n && n.h) || 0,
          text: String((n && n.text) || ""),
        }))
      : [];
    const out = {
      ok: true,
      path: String(v.path || ""),
      markdown: String(v.markdown || ""),
      width: Number(v.width) || 0,
      height: Number(v.height) || 0,
      notes: notes,
    };
    if (String(v.text || "").trim()) out.text = String(v.text || "").trim().slice(0, 4000);
    if (v.supplied) out.supplied = true;
    return out;
  }

  /* 用户给的路径常带成对引号 / file:/// 前缀（从属性框、聊天里复制来的） */
  function normPath(raw) {
    let s = String(raw == null ? "" : raw)
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    if (/^file:\/\//i.test(s)) {
      try {
        s = decodeURIComponent(s.replace(/^file:\/\//i, "")).replace(/^\/([A-Za-z]:)/, "$1");
      } catch (_) {}
    }
    return s;
  }

  /* 图片路径体检：空串 = 能用；否则返回一句给用户看的原因（只读，不写盘） */
  async function imagePathError(raw) {
    const p = normPath(raw);
    if (!p) return "";
    if (!IMG_EXT.test(p)) return T("这不是一张图片（png / jpg / webp / gif / bmp）：") + p;
    const api = window.api || {};
    let st = null;
    try {
      st = await api.fileStat(p);
    } catch (_) {
      st = null;
    }
    if (!st || st.ok !== true) return T("这个路径不存在：") + p;
    let dir = false;
    try {
      dir = !!(await api.fileIsDir(p));
    } catch (_) {
      dir = false;
    }
    if (dir) return T("这是个文件夹，不是图片：") + p;
    return "";
  }

  /* ── 那只对话框 ──────────────────────────────────────────────────────────
     返回值 { action:"cancel"|"text"|"shot", text, path }；没有 mtDialogForm
     （极简构建 / 自验沙箱）时回 null —— 调用方退回老口径，让主进程弹原生询问窗。
     用的是全应用同一只 #mtDialog（mtDialogForm）：带输入的浮层一律 persistent，
     只走窗内按钮 / Esc 关闭，点窗外不关。 */
  function askWhat(reason, seed) {
    if (typeof mtDialogForm !== "function") return Promise.resolve(null);
    const st = seed || {};
    const api = window.api || {};
    let picked = String(st.path || "");
    let readPath = () => picked;
    const why = String(reason || "").trim();
    return Promise.resolve(
      mtDialogForm({
        title: T("截图 / 给一张图"),
        msg: why || T("Agent 想请你截一张图，或者把一张已有的图片交给它。"),
        warn: String(st.error || "") || undefined,
        textarea: {
          label: T("说的话"),
          rows: 4,
          placeholder: T("跟会话输入框一样：写点什么交给 Agent（可留空）"),
          value: String(st.text || ""),
        },
        hint: T(
          "填了图片路径就点「交回」—— 那张图直接交给 Agent，不再冻结屏幕；要现场框选标注才点「开始截图…」。",
        ),
        custom: (box) => {
          const wrap = document.createElement("div");
          wrap.className = "mt-shotask";
          const lab = document.createElement("label");
          lab.className = "mt-form-lab";
          lab.textContent = T("本机图片路径（可留空）");
          const row = document.createElement("div");
          row.className = "mt-shotask-row";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.className = "mt-form-input mt-shotask-path";
          inp.placeholder = T("例如 D:\\shots\\error.png");
          inp.value = picked;
          const pickBtn = document.createElement("button");
          pickBtn.type = "button";
          pickBtn.className = "mini";
          pickBtn.textContent = T("选择图片…");
          const tip = document.createElement("p");
          tip.className = "mt-form-hint mt-shotask-tip";
          tip.hidden = true;
          let seq = 0;
          let timer = null;
          const say = (msg, bad) => {
            tip.textContent = msg || "";
            tip.hidden = !msg;
            tip.classList.toggle("bad", !!bad);
            inp.classList.toggle("invalid", !!bad);
          };
          const check = async () => {
            const mine = ++seq;
            const val = normPath(inp.value);
            if (!val) {
              say("");
              return;
            }
            const bad = await imagePathError(val);
            if (mine !== seq) return;
            say(bad || T("这张图可以用"), !!bad);
          };
          const queue = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              timer = null;
              check();
            }, 300);
          };
          inp.oninput = () => {
            picked = String(inp.value || "");
            queue();
          };
          pickBtn.onclick = async () => {
            let r = null;
            try {
              r = await api.fileOpenDialog({
                title: T("选择一张图片"),
                filters: [{ name: T("图片"), extensions: IMG_EXTS }],
                defaultPath: normPath(inp.value) || undefined,
              });
            } catch (_) {
              r = null;
            }
            if (r && r.path) {
              picked = String(r.path);
              inp.value = picked;
              say("");
              check();
              try {
                inp.focus();
              } catch (_) {}
            }
          };
          row.appendChild(inp);
          row.appendChild(pickBtn);
          wrap.appendChild(lab);
          wrap.appendChild(row);
          wrap.appendChild(tip);
          box.appendChild(wrap);
          readPath = () => String(inp.value || "");
        },
        actions: [
          { id: "cancel", label: T("取消") },
          { id: "shot", label: T("开始截图…") },
          { id: "text", label: T("交回"), primary: true },
        ],
      }),
    )
      .then((r) => {
        const action = String((r && r.action) || "");
        if (action !== "text" && action !== "shot") return { action: "cancel", text: "", path: "" };
        return {
          action: action,
          text: String((r && r.text) || "").trim(),
          path: normPath(readPath()),
        };
      })
      .catch(() => ({ action: "cancel", text: "", path: "" }));
  }

  /* 询问 → 三条出路。同一轮最多重问 3 次（路径写错 / 什么都没给时把原因带回对话框）。 */
  async function runShot(api, reason) {
    let seed = null;
    for (let i = 0; i < 3; i++) {
      const pick = await askWhat(reason, seed);
      /* 没有对话框能力：退回老口径（主进程那只原生询问窗还在，它会问过用户才抢屏） */
      if (!pick) return api.shotAgent({ reason: reason });
      if (pick.action === "cancel") return { ok: false, canceled: true };
      const text = String(pick.text || "").trim().slice(0, 4000);
      const path = normPath(pick.path);
      /* 「开始截图…」：用户已经在对话框里点过头，主进程不必再问一遍（confirmed） */
      if (pick.action === "shot") {
        const r = await api.shotAgent({ reason: reason, confirmed: true });
        const v = r && typeof r === "object" ? r : {};
        if (v.ok === true && text) v.text = text;
        return v;
      }
      if (!path) {
        if (text) return { ok: true, supplied: false, path: "", text: text };
        seed = { text: "", path: "", error: T("写一句话交给 Agent，或者填一张图片的路径。") };
        continue;
      }
      const bad = await imagePathError(path);
      if (bad) {
        seed = { text: text, path: path, error: bad };
        continue;
      }
      return { ok: true, supplied: true, path: path, text: text };
    }
    return { ok: false, error: T("没有拿到可用的图片路径") };
  }

  function handleShotToolEvent(data, replyOverride) {
    const id = data && data.id;
    if (!id) return;
    const reply =
      typeof replyOverride === "function"
        ? replyOverride
        : (result, error) =>
            window.api
              .dshInteract({ kind: "shot", id: id, result: result, error: error || undefined })
              .catch(() => {});
    const api = window.api;
    if (!api || typeof api.shotAgent !== "function") {
      reply({ ok: false, error: T("截图工具未接线（缺少 preload 桥）") });
      return;
    }
    const p = (data && data.params) || {};
    Promise.resolve(runShot(api, String(p.reason || "")))
      .then((r) => {
        const v = r && typeof r === "object" ? r : {};
        if (v.ok) reply(toolResult(v));
        else if (v.canceled) reply({ ok: false, canceled: true });
        else reply({ ok: false, error: String(v.error || "") || T("截图失败") });
      })
      .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
  }

  window.MTNodeShot = { handleToolEvent: handleShotToolEvent };
})();

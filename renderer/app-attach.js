/* 会话附件（PDF / Word / 文本 / 表格）：输入区上方的附件条 + 「＋」/ 拖入两个入口。
 *
 * 链路（谁负责哪一段）：
 *   ① 选文件 / 拖入 → 这里（renderer）：`api.fileOpenDialog` 或 `getPathForFile` 拿本机路径；
 *   ② 上传 → `api.filesPlan` 定类型与 purpose（规则只在 files-upload.js 一份），
 *      `api.filesUpload` 传到服务商 Files API，拿回 file_id（中转 404 时回
 *      `files_api_unsupported`，这张卡片就地显示失败原因，退化成「本地路径」随消息发出去）；
 *   ③ 发送 → app-assist.js 的 agentSessionSend 取走「已就绪」那几条，挂到这一轮的用户消息上
 *      （msg.files）并随 run 参数下发（app-db.js 的 runParams.files）；
 *   ④ 网关 → gateway.mjs 把 file_id 写进用户消息末尾的附件标记；
 *   ⑤ 运行时 → web-tools-plugin.mjs 在 fetch 层把标记还原成服务商原生的附件部分
 *      （OpenAI 面 `{type:'file',file_id}`；Messages 面 `{type:'document',…}`）。
 *      标记格式与自我保护（跨服务商 / 过期丢弃）的唯一真源是 llm-attachments.mjs。
 *
 * 为什么不做成富文本：输入框是 <textarea>，取值 / 草稿 / 队列 / 斜杠命令 / Enter 发送全挂在
 * .value 上（与内嵌图同一口径，见 app-assist.js「输入框的内嵌图像」段的说明）。附件是
 * 「这一轮的随件」，不进正文，所以它有自己的条，不插正文一行。
 *
 * 失败纪律：上传失败不拦发送（退化成把本机路径交给模型）；取不到路径 / 没有 api / 超过上限
 * 都只提示一句，绝不打断用户正在写的话。 */
(function () {
  const MAX_FILES = 8;
  /* 服务商能解析的常见文档类型：卡片只用来做默认筛选项，用户点「全部文件」仍可选任意类型 */
  const FILTERS = [
    {
      name: "文档 / 表格 / 文本",
      extensions: ["pdf", "docx", "doc", "txt", "md", "csv", "json", "xlsx", "xls", "pptx", "html"],
    },
    { name: "全部文件", extensions: ["*"] },
  ];
  /** 每个会话一份待发附件（切会话各看各的，不串台） */
  const byOwner = new Map();
  let uidSeq = 0;
  let bound = false;

  function api() {
    return (typeof window !== "undefined" && window.api) || null;
  }
  function t(s) {
    try {
      return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
    } catch (_) {
      return s;
    }
  }
  function toastSafe(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind || "warn");
    } catch (_) {}
  }
  /* 当前会话 id：取不到就退回空串（空串也是一份独立的槽，不会污染别的会话） */
  function ownerNow() {
    try {
      const st = typeof agentSessionState === "function" ? agentSessionState() : null;
      return String((st && st.id) || "");
    } catch (_) {
      return "";
    }
  }
  function listOf(owner) {
    const k = String(owner == null ? ownerNow() : owner);
    if (!byOwner.has(k)) byOwner.set(k, []);
    return byOwner.get(k);
  }
  function baseName(p) {
    const s = String(p || "");
    const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function sizeText(n) {
    const v = Number(n) || 0;
    if (!v) return "";
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    return (v / 1024 / 1024).toFixed(1) + " MB";
  }
  function elem(id) {
    return typeof document !== "undefined" ? document.getElementById(id) : null;
  }

  /* ── 渲染输入区上方的附件条 ────────────────────────────────────────────── */
  function chipEl(item) {
    const chip = document.createElement("span");
    chip.className = "agent-attach-chip is-" + String(item.status || "queued");
    chip.dataset.uid = String(item.uid || "");
    const ico = document.createElement("span");
    ico.className = "agent-attach-ico";
    ico.textContent = item.status === "failed" ? "⚠" : "📄";
    chip.appendChild(ico);
    const name = document.createElement("span");
    name.className = "agent-attach-name";
    name.textContent = item.name || baseName(item.path) || "文件";
    chip.appendChild(name);
    const note =
      item.status === "uploading"
        ? t("上传中…")
        : item.status === "failed"
          ? t("未上传：") + String(item.error || "")
          : item.status === "ready"
            ? sizeText(item.size) || t("已就绪")
            : "";
    if (note) {
      const sub = document.createElement("span");
      sub.className = "agent-attach-note";
      sub.textContent = note;
      chip.appendChild(sub);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "agent-attach-x";
    x.title = t("移除这个附件");
    x.textContent = "✕";
    x.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeItem(item.uid);
    });
    chip.appendChild(x);
    return chip;
  }
  function paint() {
    const box = elem("agentAttach");
    if (!box) return;
    const list = listOf();
    box.textContent = "";
    box.hidden = !list.length;
    for (const item of list) box.appendChild(chipEl(item));
  }
  /* 消息里的附件行（只读）：历史消息 / 刚发出去的那条都按同一份数据画 */
  function stripEl(files) {
    const list = Array.isArray(files) ? files.filter((f) => f && (f.name || f.path)) : [];
    if (!list.length) return null;
    const row = document.createElement("div");
    row.className = "dsh-attach-row";
    for (const f of list) {
      const chip = document.createElement("span");
      chip.className = "agent-attach-chip is-sent";
      chip.title = String(f.path || f.fileId || "");
      const ico = document.createElement("span");
      ico.className = "agent-attach-ico";
      ico.textContent = "📄";
      chip.appendChild(ico);
      const name = document.createElement("span");
      name.className = "agent-attach-name";
      name.textContent = String(f.name || baseName(f.path) || "文件");
      chip.appendChild(name);
      const sub = sizeText(f.size);
      if (sub) {
        const note = document.createElement("span");
        note.className = "agent-attach-note";
        note.textContent = sub;
        chip.appendChild(note);
      }
      row.appendChild(chip);
    }
    return row;
  }

  /* ── 上传 ──────────────────────────────────────────────────────────────── */
  async function uploadOne(owner, item) {
    const a = api();
    if (!a || !a.filesUpload) {
      item.status = "failed";
      item.error = t("当前版本没有上传通道");
      paint();
      return;
    }
    const st = (function () {
      try {
        return typeof agentSessionState === "function" ? agentSessionState() : null;
      } catch (_) {
        return null;
      }
    })();
    const route =
      typeof agentSessionProviderRoute === "function"
        ? agentSessionProviderRoute(st)
        : String((st && st.provider) || "") || "deepseek-official";
    item.status = "uploading";
    paint();
    let purpose = "";
    try {
      const plan = a.filesPlan ? await a.filesPlan({ path: item.path }) : null;
      const first = plan && plan.ok && Array.isArray(plan.files) ? plan.files[0] : null;
      if (first) {
        purpose = String(first.purpose || "");
        item.kind = String(first.kind || item.kind || "");
        item.size = Number(first.size) || item.size;
      }
    } catch (_) {}
    let r = null;
    try {
      r = await a.filesUpload({
        path: item.path,
        name: item.name,
        purpose: purpose || undefined,
        sessionId: owner,
        providerRoute: route,
      });
    } catch (err) {
      r = { ok: false, code: "files_ipc_failed", error: String((err && err.message) || err) };
    }
    if (r && r.ok && r.fileId) {
      item.status = "ready";
      item.fileId = String(r.fileId);
      item.host = String(r.host || "");
      item.at = Number(r.at) || Date.now();
      item.kind = String(r.kind || item.kind || "");
      item.size = Number(r.size) || item.size;
      item.purpose = String(r.purpose || purpose || "");
      item.error = "";
    } else {
      item.status = "failed";
      item.error = String((r && (r.error || r.code)) || t("上传失败"));
    }
    paint();
  }

  /* 一批路径入队（去重 + 上限），随后逐条上传 */
  function addPaths(paths) {
    const owner = ownerNow();
    const list = listOf(owner);
    const incoming = (Array.isArray(paths) ? paths : [paths]).map((p) => String(p || "").trim()).filter(Boolean);
    if (!incoming.length) return 0;
    let added = 0;
    const queue = [];
    for (const p of incoming) {
      if (list.length >= MAX_FILES) {
        toastSafe(t("一次最多带 ") + MAX_FILES + t(" 个文件"), "warn");
        break;
      }
      if (list.some((x) => x.path === p)) continue;
      const item = {
        uid: "f" + ++uidSeq,
        path: p,
        name: baseName(p),
        kind: "",
        size: 0,
        purpose: "",
        fileId: "",
        host: "",
        at: 0,
        status: "queued",
        error: "",
      };
      list.push(item);
      queue.push(item);
      added++;
    }
    paint();
    (async () => {
      for (const item of queue) await uploadOne(owner, item);
    })();
    return added;
  }

  function removeItem(uid) {
    const list = listOf();
    const i = list.findIndex((x) => String(x.uid) === String(uid));
    if (i >= 0) list.splice(i, 1);
    paint();
  }

  /* 发送时取走「已就绪」的那几条（失败的不带 file_id，但本机路径一并交给网关，
     让模型至少能用本地读文件工具读） */
  function take() {
    const list = listOf();
    const out = [];
    for (const item of list) {
      if (item.status === "ready" && item.fileId) {
        out.push({
          fileId: item.fileId,
          name: item.name,
          kind: item.kind,
          size: item.size,
          purpose: item.purpose,
          host: item.host,
          at: item.at,
          path: item.path,
        });
      } else if (item.status === "failed" && item.path) {
        out.push({ name: item.name, kind: item.kind, size: item.size, path: item.path, unsupported: true });
      }
    }
    list.length = 0;
    paint();
    return out;
  }

  /* 「＋」：系统选文件框（多选）→ 入队 */
  async function pick() {
    const a = api();
    if (!a || !a.fileOpenDialog) {
      toastSafe(t("当前版本打不开文件选择框"), "warn");
      return;
    }
    let r = null;
    try {
      r = await a.fileOpenDialog({
        title: t("添加文件（随这条消息发给模型）"),
        filters: FILTERS,
        multi: true,
      });
    } catch (err) {
      toastSafe(t("打开文件选择框失败：") + String((err && err.message) || err), "warn");
      return;
    }
    const paths = (r && (r.paths && r.paths.length ? r.paths : r.path ? [r.path] : [])) || [];
    if (paths.length) addPaths(paths);
  }

  /* ── 事件绑定（只绑一次） ───────────────────────────────────────────────── */
  function nonImageFiles(dt) {
    const files = Array.from((dt && dt.files) || []);
    if (!files.length) return [];
    return files.filter((f) => !/^image\//i.test(String((f && f.type) || "")));
  }
  function pathsOfFiles(files) {
    const a = api();
    const out = [];
    for (const f of files) {
      let p = "";
      try {
        if (a && a.getPathForFile) p = String(a.getPathForFile(f) || "");
      } catch (_) {}
      if (!p) p = String((f && f.path) || "");
      if (p) out.push(p);
    }
    return out;
  }
  function bind() {
    if (bound) return;
    bound = true;
    const btn = elem("agentAttachBtn");
    if (btn) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        pick();
      });
    }
    /* 拖入：落在输入卡片上就算（图片仍归 app-inline-img.js：它在 textarea 上先处理并
       preventDefault，这里只接非图片文件） */
    const card = typeof document !== "undefined" ? document.querySelector(".agent-composer") : null;
    const dropZone = (card && card.querySelector(".agent-composer-card")) || card;
    if (dropZone) {
      dropZone.addEventListener("dragover", (ev) => {
        const dt = ev.dataTransfer;
        if (!dt || !nonImageFiles(dt).length) return;
        ev.preventDefault();
        try {
          dt.dropEffect = "copy";
        } catch (_) {}
      });
      dropZone.addEventListener("drop", (ev) => {
        const dt = ev.dataTransfer;
        const files = nonImageFiles(dt);
        if (!files.length) return;
        ev.preventDefault();
        ev.stopPropagation();
        const paths = pathsOfFiles(files);
        if (!paths.length) {
          toastSafe(t("拖入的文件取不到本机路径（请用「＋」选择文件）"), "warn");
          return;
        }
        addPaths(paths);
      });
    }
    paint();
  }

  const ATT = {
    init: bind,
    paint,
    pick,
    addPaths,
    remove: removeItem,
    take,
    stripEl,
    owner: ownerNow,
    MAX: MAX_FILES,
  };
  if (typeof window !== "undefined") window.Attach = ATT;
  /* 脚本按 index.html 的顺序加载（在 app-assist.js 之前），DOM 此时还没就绪 →
     DOMContentLoaded 再绑；之后的整页重绘不影响（绑定挂在容器上，容器不重建）。 */
  if (typeof document !== "undefined") {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", () => {
        try {
          bind();
        } catch (_) {}
      });
    else {
      try {
        bind();
      } catch (_) {}
    }
  }
})();

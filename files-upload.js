/* files-upload.js — 官方 Files API 上传通道（multipart → {baseUrl}/files）
 *
 * ── 这只模块解决什么 ──────────────────────────────────────────────────────
 * 会话里挂的文档（PDF / Word / PPT / 图片 / 表格 / 纯文本）先上传到服务商的
 * Files API，拿回 file_id 随消息一起进上下文，比"本地转成几万字正文再塞 prompt"
 * 省 token、也不丢版面。上传只走主进程：**apiKey 一个字都不经过渲染层**。
 *
 * ── 三条硬约束（改动前先读）────────────────────────────────────────────
 * ① **purpose 字段必须排在 file 之前**：这个接口是流式 multipart，服务端读到
 *    file 分片时就必须已经知道 purpose，否则按默认 purpose 建文件（或直接 400）。
 *    所以 body 由本模块自己拼 Buffer，而不是用 FormData 靠"插入顺序"碰运气。
 * ② **超时按"上传 + 解析"放宽**（默认 180s ≥ 120s）：上传完服务端还要按 purpose
 *    抽文本 / 做版面识别，几 MB 的 PDF 解析几十秒是常态；按聊天请求那套 60s 掐
 *    会把"其实已经成功"的上传判成失败。
 * ③ **purpose 只按类型选**（不猜内容）：
 *      PDF / Word / PPT / 图片 → text_recognition 或 rich_layout_recognition
 *                                 （用户在附件卡片上选，缺省 text_recognition）
 *      txt / md / csv / json / 代码 / xlsx / epub → user_data
 *    规则只在 plan() 里写一份，渲染层照着 purposes 画下拉，不复制规则。
 *
 * ── 降级口径 ───────────────────────────────────────────────────────────
 * 中转站（MTNode 中转服务）没有 Files API：`POST {中转 baseUrl}/files` 回 404。
 * 这种失败**不是错误**，是"这条通道在这家服务商上不存在"，所以回可识别的降级码
 * code="files_api_unsupported" + fallback="local"，调用方据此转本地解析兜底
 * （pdf:parse / 本地文本抽取），不要把 404 弹成一次上传失败。
 *
 * ── 会话落点 ───────────────────────────────────────────────────────────
 * 传了 sessionId 时，成功的 file_id 会记进主进程侧的会话附件账本
 * <数据目录>/files-uploads/<sessionId>.json（最多留 200 条）：刷新、切会话、重启后
 * 都能拿回"这条会话上传过哪些文件"，files:sessionFiles 读它。会话正文里的附件卡片
 * 仍是渲染层的记录，账本只是主进程侧那份留痕（两边 key 都是同一个 fileId）。
 *
 * ── 独立性（为什么单独一个文件 + build.json 白名单）────────────────────
 * 不 require main.js：数据目录 / 日志由 init 注入（与 agent-sessions-store.js 同一口径），
 * 可以独立冒烟。密钥只作为参数进来，**绝不进返回值、绝不进日志、错误文案里出现也打码**。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { randomBytes } = require("crypto");

/* 上传 + 解析的总预算：低于 120s 会把"服务端正在解析"判成超时（见文件头②） */
const DEFAULT_TIMEOUT_MS = 180 * 1000;
/* 单文件上限：整份读进内存再发（multipart 必须知道 Content-Length），200MB 是
   远高于服务商限制的兜底，只用来挡住"把一整个安装包拖进来"这种明显误操作。 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const LEDGER_MAX = 200;
const LEDGER_DIR = "files-uploads";

/* 降级码：中转 / 不支持的网关上 POST /files 回 404 —— 调用方据此转本地解析 */
const CODE_UNSUPPORTED = "files_api_unsupported";

/* 类型 → purpose 候选。顺序有意义：第一项是缺省（卡片不选时用它）。 */
const PURPOSE_OPTIONS = {
  doc: ["text_recognition", "rich_layout_recognition"],
  image: ["text_recognition", "rich_layout_recognition"],
  user_data: ["user_data"],
};

/* 需要"识别"的文档类（服务端会把它们变成结构化文本 / 版面） */
const DOC_EXTS = new Set(["pdf", "doc", "docx", "ppt", "pptx", "rtf", "odt", "odp"]);
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
]);
/* 其余按"原始数据文件"传（user_data）：文本 / 代码 / 表格 / 电子书 */
const USER_DATA_EXTS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "log",
  "xlsx",
  "xls",
  "epub",
  /* 代码 */
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "rb",
  "lua",
  "sh",
  "bash",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "vue",
  "ipynb",
]);

const MIME_BY_EXT = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  xml: "application/xml",
  yml: "application/yaml",
  yaml: "application/yaml",
  toml: "application/toml",
  ini: "text/plain",
  log: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  epub: "application/epub+zip",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
};

function extOf(name) {
  const s = String(name || "");
  const i = s.lastIndexOf(".");
  if (i < 0 || i === s.length - 1) return "";
  return s.slice(i + 1).toLowerCase();
}

function kindOf(ext) {
  if (DOC_EXTS.has(ext)) return "doc";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "user_data";
}

function purposesOf(kind) {
  return (PURPOSE_OPTIONS[kind] || PURPOSE_OPTIONS.user_data).slice();
}

function defaultPurposeOf(kind) {
  return purposesOf(kind)[0];
}

/* purpose 只认该类型允许的那几个：卡片传错 / 传了别的类型的值一律回落到缺省，
   绝不把 "user_data" 塞给 PDF（那样服务端只会存原始字节，模型永远读不到正文）。 */
function normalizePurpose(kind, wanted) {
  const list = purposesOf(kind);
  const s = String(wanted || "").trim();
  return list.indexOf(s) >= 0 ? s : list[0];
}

function mimeOf(name) {
  const ext = extOf(name);
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function baseOk(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function filesUrlOf(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "") + "/files";
}

/* 密钥可能出现在上游回显的错误文案里（有的网关会把 Authorization 抄进 message）：
   任何要回给渲染层 / 写日志的字符串都先过这一道。 */
function redact(text, apiKey) {
  let s = String(text == null ? "" : text);
  const key = String(apiKey || "");
  if (key) s = s.split(key).join("***");
  return s;
}

/* 从服务商应答里取 file_id：官方是 { id, object:"file", … }，兼容 file_id / 包一层 data 的写法 */
function fileIdOf(doc) {
  if (!doc || typeof doc !== "object") return "";
  const inner = doc.data && typeof doc.data === "object" ? doc.data : null;
  const pick = (o) =>
    o && typeof o === "object"
      ? String(o.id || o.file_id || o.fileId || "").trim()
      : "";
  return pick(doc) || pick(inner);
}

/* multipart body：**purpose 分片先写、file 分片最后写**（见文件头①）。
   fields 是纯文本分片的有序数组，filePart 是唯一的文件分片。 */
function buildMultipartBody(boundary, fields, filePart) {
  const chunks = [];
  const put = (s) => chunks.push(Buffer.from(s, "utf8"));
  for (const [name, value] of fields) {
    put("--" + boundary + "\r\n");
    put('Content-Disposition: form-data; name="' + name + '"\r\n\r\n');
    put(String(value) + "\r\n");
  }
  put("--" + boundary + "\r\n");
  put(
    'Content-Disposition: form-data; name="' +
      filePart.field +
      '"; filename="' +
      filePart.filename +
      '"\r\n',
  );
  put("Content-Type: " + filePart.contentType + "\r\n\r\n");
  chunks.push(filePart.buf);
  put("\r\n--" + boundary + "--\r\n");
  return Buffer.concat(chunks);
}

/* filename 进 Content-Disposition：引号 / 换行必须清掉（换行会把 multipart 头撕开），
   其余保持 UTF-8 原样（服务端按 UTF-8 解，与浏览器行为一致）。 */
function safeFilename(name) {
  return String(name || "file").replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim() || "file";
}

/* 一条 POST：自己管超时（整体预算，不是 socket 空闲），回 { status, text }。
   网络层失败不 reject —— 统一由调用方转 code，避免每条路径各写一份 try/catch。 */
function postMultipart(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let url = null;
    try {
      url = new URL(String(o.url || ""));
    } catch {
      resolve({ status: 0, text: "", error: "bad_url", code: "files_bad_base_url" });
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const headers = {
      Authorization: "Bearer " + String(o.apiKey || ""),
      "Content-Type": "multipart/form-data; boundary=" + o.boundary,
      "Content-Length": String(o.body.length),
      Accept: "application/json",
    };
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];
        let got = 0;
        res.on("data", (c) => {
          chunks.push(c);
          got += c.length;
          /* 防御：异常大的回显不至于把主进程内存拉满（正常应答几百字节） */
          if (got > 4 * 1024 * 1024) {
            try {
              req.destroy();
            } catch {}
            finish({ status: 0, text: "", error: "应答过大", code: "files_bad_response" });
          }
        });
        res.on("end", () => {
          finish({
            status: Number(res.statusCode || 0) || 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", (e) => {
          finish({ status: 0, text: "", error: String((e && e.message) || e), code: "files_network" });
        });
      },
    );
    timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {}
      finish({ status: 0, text: "", error: "timeout", code: "files_timeout" });
    }, Math.max(1000, Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS));
    req.on("error", (e) => {
      const msg = String((e && e.message) || e);
      finish({
        status: 0,
        text: "",
        error: msg,
        code: /timeout|ETIMEDOUT/i.test(msg) ? "files_timeout" : "files_network",
      });
    });
    req.end(o.body);
  });
}

/* HTTP 状态 → 可识别 code。404 是降级码（见文件头"降级口径"），其余给调用方区分
   是 Key 的问题还是文件的问题，别把一切都弹成"上传失败"。 */
function codeOfStatus(status) {
  const s = Number(status) || 0;
  if (s === 404) return CODE_UNSUPPORTED;
  if (s === 401 || s === 403) return "files_auth_failed";
  if (s === 413) return "files_too_large";
  if (s === 429) return "files_rate_limited";
  if (s >= 500) return "files_server_error";
  if (s >= 400) return "files_bad_request";
  return "files_http_error";
}

/* 上游错误文案：服务商一般给 { error: { message } } / { message } / { error: "…" } */
function errorTextOf(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  try {
    const doc = JSON.parse(s);
    const e = doc && doc.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && e.message) return String(e.message);
    if (doc && doc.message) return String(doc.message);
    if (doc && doc.msg) return String(doc.msg);
    return s.slice(0, 400);
  } catch {
    return s.slice(0, 400);
  }
}

function createFilesUpload(opts) {
  const o = opts || {};
  const dataDir = typeof o.dataDir === "function" ? o.dataDir : () => String(o.dataDir || "");
  const log = typeof o.log === "function" ? o.log : () => {};

  const ledgerDir = () => path.join(String(dataDir() || ""), LEDGER_DIR);
  const ledgerPath = (sessionId) =>
    path.join(ledgerDir(), String(sessionId || "").replace(/[^\w.-]+/g, "_") + ".json");

  /* 会话附件账本：读失败 / 坏了都当空（它只是留痕，不能反过来挡住上传） */
  function readSessionFiles(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) return [];
    try {
      const list = JSON.parse(fs.readFileSync(ledgerPath(id), "utf8"));
      return Array.isArray(list) ? list.filter((x) => x && x.fileId) : [];
    } catch {
      return [];
    }
  }

  function landOnSession(sessionId, rec) {
    const id = String(sessionId || "").trim();
    if (!id || !dataDir()) return false;
    try {
      const list = readSessionFiles(id);
      /* 同 fileId 只留一条（重传同一个文件不重复记账） */
      const next = list.filter((x) => String(x.fileId) !== String(rec.fileId));
      next.push(rec);
      const trimmed = next.slice(Math.max(0, next.length - LEDGER_MAX));
      const dir = ledgerDir();
      fs.mkdirSync(dir, { recursive: true });
      const tmp = ledgerPath(id) + ".tmp" + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(trimmed), "utf8");
      fs.renameSync(tmp, ledgerPath(id));
      return true;
    } catch (e) {
      log("[files] 会话附件账本写入失败 " + id + "：" + String((e && e.message) || e));
      return false;
    }
  }

  /* 卡片用：给一批文件算类型 / 可选 purpose / 缺省 purpose / 大小。
     规则只在这里（见文件头③），渲染层照着画下拉，不再抄一份。 */
  function plan(payload) {
    const p = payload || {};
    const list = Array.isArray(p.files) ? p.files : p.path ? [p] : [];
    const out = [];
    for (const raw of list) {
      /* 条目可以是纯路径字符串，也可以是 { path, name, purpose }（卡片两种都给得出来） */
      const item = typeof raw === "string" ? { path: raw } : raw || {};
      const full = String(item.path || item.file || "").trim();
      const name = String(item.name || "") || path.basename(full || "");
      if (!full && !name) continue;
      const ext = extOf(name || full);
      const kind = kindOf(ext);
      let size = 0;
      try {
        size = full ? fs.statSync(full).size : 0;
      } catch {}
      out.push({
        path: full,
        name,
        ext,
        kind,
        size,
        purposes: purposesOf(kind),
        defaultPurpose: defaultPurposeOf(kind),
        purpose: normalizePurpose(kind, item && item.purpose),
        /* 类型之外的一句话说清"这个 purpose 会怎么被处理"，卡片可以原样显示 */
        note:
          kind === "doc"
            ? "文档：text_recognition = 抽正文，rich_layout_recognition = 保版面（表格 / 多栏）"
            : kind === "image"
              ? "图片：text_recognition = 抽文字，rich_layout_recognition = 保版面（图表 / 表格）"
              : "按原始数据文件上传（不解析）",
      });
    }
    return { ok: true, files: out };
  }

  /* 一次上传。调用方（main.js 的 files:upload）已经把服务商解析成
     { baseUrl, apiKey }（密钥不出主进程），这里只发请求、判降级、落账。 */
  async function upload(payload) {
    const p = payload || {};
    const full = String(p.path || "").trim();
    if (!full) {
      return { ok: false, code: "files_bad_request", error: "缺少文件路径（path）" };
    }
    const name = String(p.name || "").trim() || path.basename(full);
    const ext = extOf(name || full);
    const kind = kindOf(ext);
    const purpose = normalizePurpose(kind, p.purpose);
    const baseUrl = String(p.baseUrl || "").trim();
    const apiKey = String(p.apiKey || "");
    if (!baseOk(baseUrl)) {
      return {
        ok: false,
        code: "files_bad_base_url",
        error: "当前会话服务商没有可用的接口地址（设置 · API/配置）",
      };
    }
    if (!apiKey) {
      return {
        ok: false,
        code: "files_no_key",
        error: "当前会话服务商没有可用的 API Key（设置 · API/配置）",
      };
    }
    let buf = null;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) {
        return { ok: false, code: "files_bad_request", error: "只能上传文件，不能上传文件夹" };
      }
      if (st.size > MAX_FILE_BYTES) {
        return {
          ok: false,
          code: "files_too_large",
          error: "文件超过 " + Math.round(MAX_FILE_BYTES / 1024 / 1024) + "MB，无法上传",
          size: st.size,
        };
      }
      if (!st.size) {
        return { ok: false, code: "files_bad_request", error: "空文件（0 字节）无需上传" };
      }
      buf = fs.readFileSync(full);
    } catch (e) {
      return {
        ok: false,
        code: "files_bad_request",
        error: "读不到这个文件：" + redact((e && e.message) || e, apiKey),
      };
    }
    const boundary = "----mtnode" + randomBytes(12).toString("hex");
    /* purpose 在前、file 在后（硬约束①） */
    const body = buildMultipartBody(
      boundary,
      [["purpose", purpose]],
      {
        field: "file",
        filename: safeFilename(name),
        contentType: mimeOf(name || full),
        buf,
      },
    );
    const url = filesUrlOf(baseUrl);
    const r = await postMultipart({
      url,
      apiKey,
      body,
      boundary,
      timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(p.timeoutMs) || 0),
    });
    log(
      "[files] 上传 " + name + "（" + kind + " / " + purpose + "，" + buf.length + "B）→ " +
        url + " status=" + (r.status || r.code || 0),
    );
    if (r.code && !r.status) {
      return {
        ok: false,
        code: r.code,
        status: 0,
        error: r.error || "网络请求失败",
        fallback: r.code === "files_timeout" ? "local" : "",
      };
    }
    if (r.status < 200 || r.status >= 300) {
      const code = codeOfStatus(r.status);
      const upstream = redact(errorTextOf(r.text), apiKey);
      return {
        ok: false,
        code,
        status: r.status,
        /* 404 = 这家服务商（典型是中转站）没有 Files API：这是可预期的降级，
           不是"上传失败"，文案也按降级说，调用方转本地解析。 */
        error:
          code === CODE_UNSUPPORTED
            ? "当前会话服务商不提供 Files API（中转站），请改走本地解析"
            : upstream || "上传失败（HTTP " + r.status + "）",
        upstream: upstream || "",
        fallback: code === CODE_UNSUPPORTED ? "local" : "",
      };
    }
    let doc = null;
    try {
      doc = JSON.parse(r.text);
    } catch {
      doc = null;
    }
    const fileId = fileIdOf(doc);
    if (!fileId) {
      return {
        ok: false,
        code: "files_no_file_id",
        status: r.status,
        error: "服务商没有返回 file_id" + (r.text ? "：" + redact(r.text, apiKey).slice(0, 200) : ""),
        fallback: "local",
      };
    }
    const bytes = Number((doc && (doc.bytes || doc.size)) || buf.length) || buf.length;
    const rec = {
      fileId,
      name,
      purpose,
      kind,
      size: buf.length,
      at: Date.now(),
      /* 只留域名级别，便于排障又不泄露中转地址细节 */
      host: (() => {
        try {
          return new URL(baseUrl).host;
        } catch {
          return "";
        }
      })(),
    };
    const landed = p.sessionId ? landOnSession(p.sessionId, rec) : false;
    return {
      ok: true,
      fileId,
      purpose,
      kind,
      name,
      size: buf.length,
      bytes,
      host: rec.host,
      at: rec.at,
      sessionId: String(p.sessionId || ""),
      landed,
    };
  }

  return {
    /* 供 main.js / 冒烟用：常量与纯函数 */
    plan,
    upload,
    readSessionFiles,
    DEFAULT_TIMEOUT_MS,
    CODE_UNSUPPORTED,
    /* 纯规则（渲染层要画下拉也只应经 files:plan 拿，这里导出是给冒烟对账） */
    kindOf,
    purposesOf,
    defaultPurposeOf,
    normalizePurpose,
    filesUrlOf,
    buildMultipartBody,
  };
}

module.exports = { createFilesUpload };

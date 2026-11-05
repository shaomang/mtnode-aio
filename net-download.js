"use strict";

/* ── 宿主侧联网取素材（搜索 JSON + 二进制落盘）────────────────────────────────
 *
 * 为什么必须在主进程做：应用页的 CSP 是 `connect-src 'none'`（不许放宽），页面自己发不了请求；
 * 主进程的 fetch 没有跨域限制，也不受应用页 CSP 约束。
 *
 * 两个动作，只读网络、只往调用方指定的路径写一个文件：
 *   search({url, headers, timeoutMs})            → { ok, status, text, bytes, contentType }
 *   download({url, destPath, headers, maxBytes}) → { ok, path, bytes, contentType, ext }
 *
 * 两条纪律：
 *   1) 永远带一个浏览器 UA —— 不少素材站（pixabay）对默认 UA 直接掐连接，实测 20s 超时；
 *   2) 下载有字节上限与超时，不把整片视频读进内存：边读边数，超了立刻中止并删半截文件。
 * ───────────────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");

/* IPv4 优先（真机踩到的坑）：国内不少网络环境里 IPv6 是「解析得到、连不上」，而 Node 的
 * fetch 不像 curl 那样先试 IPv4（happy eyeballs）—— 实测 commons.wikimedia.org 拿到 AAAA
 * 后 10.7s 报 UND_ERR_CONNECT_TIMEOUT（curl 带同一个 UA 3.6s 就 200）。把解析顺序改成
 * IPv4 优先即 1.4s 通。只改「先试哪个」，不改「能不能用」：IPv4 连不上仍会回落到 IPv6。 */
try {
  require("node:dns").setDefaultResultOrder("ipv4first");
} catch {}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 25000;
/* 下载另算：搜一下回 30–80KB，下载动辄几 MB（实测 3.4MB 音效 10.5s、偶发更慢），
   而且超时管的是「整个请求 + 边读边写」的全程，按搜索那档 25s 会误杀。 */
const DOWNLOAD_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 300000;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_BIN_BYTES = 96 * 1024 * 1024;

/* 落盘只认这几类扩展名：素材（图 / 音 / 视频），别的扩展名一律不写 */
const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/ogg": ".ogg",
  "audio/oga": ".oga",
  "audio/opus": ".opus",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};
const OK_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac", ".mp4", ".webm", ".mov"]);

function bad(error, code) {
  return { ok: false, code: code || "failed", error: String(error || "") };
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/* 只允许字符串键值、丢掉换行（header 注入）*/
function normHeaders(h) {
  const out = {};
  if (!isObj(h)) return out;
  for (const k of Object.keys(h)) {
    const key = String(k || "").trim();
    if (!key || !/^[A-Za-z0-9-]+$/.test(key)) continue;
    const val = String(h[k] == null ? "" : h[k]).replace(/[\r\n]/g, " ").trim();
    if (val) out[key] = val;
  }
  return out;
}

function normTimeout(v, def) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return def || DEFAULT_TIMEOUT_MS;
  return Math.max(3000, Math.min(MAX_TIMEOUT_MS, Math.round(n)));
}

function okUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/* 搜索：把一页 JSON / HTML 原样回给调用方（文本，不解析 —— 解析口径在应用侧一处） */
async function search(opts) {
  const o = isObj(opts) ? opts : {};
  const url = String(o.url || "");
  if (!okUrl(url)) return bad("不是 http(s) 地址", "bad_url");
  const headers = Object.assign({ "User-Agent": UA, Accept: "application/json, */*" }, normHeaders(o.headers));
  try {
    const res = await fetch(url, {
      headers: headers,
      redirect: "follow",
      signal: AbortSignal.timeout(normTimeout(o.timeoutMs)),
    });
    if (!res.ok) return { ok: false, code: "http_" + res.status, status: res.status, error: "HTTP " + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_TEXT_BYTES) return bad("回包太大（上限 8MB）", "too_large");
    return {
      ok: true,
      status: res.status,
      contentType: String(res.headers.get("content-type") || ""),
      bytes: buf.length,
      text: buf.toString("utf8"),
    };
  } catch (err) {
    return bad((err && err.message) || err, "net_failed");
  }
}

/* 下载：流式写到 destPath，超过上限立刻中止并删掉半截文件 */
async function download(opts) {
  const o = isObj(opts) ? opts : {};
  const url = String(o.url || "");
  if (!okUrl(url)) return bad("不是 http(s) 地址", "bad_url");
  const dest = String(o.destPath || "");
  if (!dest) return bad("没给落盘路径", "bad_dest");
  const maxBytes = Math.max(1024, Math.min(MAX_BIN_BYTES, Number(o.maxBytes) || MAX_BIN_BYTES));
  const headers = Object.assign({ "User-Agent": UA, Accept: "*/*" }, normHeaders(o.headers));
  let fd = null;
  let written = 0;
  const tmp = dest + ".part";
  try {
    const res = await fetch(url, {
      headers: headers,
      redirect: "follow",
      signal: AbortSignal.timeout(normTimeout(o.timeoutMs, DOWNLOAD_TIMEOUT_MS)),
    });
    if (!res.ok) return { ok: false, code: "http_" + res.status, status: res.status, error: "HTTP " + res.status };
    const ctype = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > maxBytes) return bad("文件太大（" + Math.round(len / 1048576) + "MB，上限 " + Math.round(maxBytes / 1048576) + "MB）", "too_large");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fd = fs.openSync(tmp, "w");
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        written += value.length;
        if (written > maxBytes) {
          try { await reader.cancel(); } catch {}
          fs.closeSync(fd);
          fd = null;
          try { fs.unlinkSync(tmp); } catch {}
          return bad("下载超过上限（" + Math.round(maxBytes / 1048576) + "MB）", "too_large");
        }
        fs.writeSync(fd, Buffer.from(value));
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      written = buf.length;
      if (written > maxBytes) {
        fs.closeSync(fd);
        fd = null;
        try { fs.unlinkSync(tmp); } catch {}
        return bad("下载超过上限", "too_large");
      }
      fs.writeSync(fd, buf);
    }
    fs.closeSync(fd);
    fd = null;
    if (!written) {
      try { fs.unlinkSync(tmp); } catch {}
      return bad("下回来的是空文件", "empty");
    }
    fs.renameSync(tmp, dest);
    let ext = EXT_BY_MIME[ctype] || "";
    if (!ext) {
      try {
        ext = path.extname(new URL(url).pathname).toLowerCase();
      } catch {
        ext = "";
      }
    }
    return { ok: true, path: dest, bytes: written, contentType: ctype, ext: OK_EXT.has(ext) ? ext : "" };
  } catch (err) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    return bad((err && err.message) || err, "net_failed");
  }
}

module.exports = {
  UA,
  OK_EXT,
  EXT_BY_MIME,
  MAX_BIN_BYTES,
  search: search,
  download: download,
};

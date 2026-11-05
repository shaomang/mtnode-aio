"use strict";

/* ═══════════════ 预览 / 应用节点 iframe 的播放通道（preview-media.js）═══════════════
 *
 * 为什么有这一份：应用在**开发页中栏预览**（`_host=1`）与**画布上的应用节点**
 * （`_anode=<appId>`）里跑的都是 `mtnode-preview://` 的 iframe —— 那里没有 preload，
 * 也就没有 `appHost.media.*`。于是应用里每一处「试听 / 播放成片」都只能如实报
 * `no_host`（宿主没有播放通道（底部播放条））。独立应用窗口（preload-app.js 注入
 * renderer/app-media-ui.js 那条路）一直是好的，缺的正是这两条 iframe 路。
 *
 * 这一份补的就是它，两件事：
 *   ① **页面侧**：把宿主那条播放条（renderer/app-media-ui.js，**同一份实现**，不另写一套）
 *      与一段小助手一起注入 iframe 的 <head> 最前面（与宿主桥同一处注入点，早于应用
 *      自己的 CSP meta，所以 inline 脚本不会被应用的 script-src 'self' 挡掉）；
 *      小助手给 `window.appHost.media` 补 `urlOf / play / stop / state / fullscreen`，
 *      与 preload-app.js 那一份**同形状**，应用侧的 `AppHost.cap.media` 于是为真。
 *   ② **媒体字节**：iframe 的 origin 是 `mtnode-preview://<appId>`，浏览器不许它直接读
 *      `file:///…`（Not allowed to load local resource）——所以播放 URL 走本文件的媒体
 *      路由：`mtnode-preview://<appId>/__mtnode_media__/?p=<绝对路径>`，由主进程读盘回
 *      字节（支持 Range / 206，拖动进度条才有效）。同源 = 应用的 `media-src 'self'` 放行。
 *
 * 口径（别越界）：
 *   · **只放行媒体扩展名**（音视频 + 图片；音视频与 app-media-ui.js 的 AUDIO_EXT / VIDEO_EXT
 *     同一张表），别的文件一律 403 —— 这条路由不许变成「读本机任意文件」的后门；
 *     图片走**这条同一条**路由，是因为它要与音频 / 视频共用一条读盘通道：应用里
 *     `<img src=appHost.media.urlOf(p)>` 与播放同一套（不再另开一条 base64 通道）；
 *   · **波形退化成普通进度条**：iframe 里拿不到字节解码（应用 CSP connect-src 'none'），
 *     小助手的 waveform 如实回 `no_waveform`，播放条自己会画成进度条，点 / 拖定位照旧；
 *   · 独立应用窗口那条路**逐字不变**：这里只在 iframe 的两条注入点上生效。
 */

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

/* 媒体路由的前缀（iframe 里的播放 URL 就长这样：
   mtnode-preview://<appId>/__mtnode_media__/?p=E%3A%5C…%5Ctrial-p1.wav） */
const MEDIA_ROUTE = "/__mtnode_media__";
/* 单个文件上限：再大就不给播（防护照，不是产品口径） */
const MEDIA_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/* 图片扩展名 → Content-Type：与音视频**同一条路由**（应用页 <img src=appHost.media.urlOf(p)>
   直接可用）。app-host-bridge.js 的 fs.imageDataUrl 也用这一张表，避免两处白名单走偏。 */
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/* 音视频 + 图片扩展名 → Content-Type（音视频与 renderer/app-media-ui.js 的
   AUDIO_EXT / VIDEO_EXT 对齐：那两条正则认什么，这里就放行什么 —— 两边不一致就会出现
   「播放条认、路由不给字节」） */
const MEDIA_MIME = Object.assign({}, IMAGE_MIME, {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
});

function isMediaPath(p) {
  return !!MEDIA_MIME[String(path.extname(String(p || ""))).toLowerCase()];
}

/* 这次请求是不是媒体路由（apps-store.js 的预览协议 handler 在最前面判一下）
   —— 只认 `/__mtnode_media__` 本身与它下面的一层，别把 `/__mtnode_media__2/…` 也吃进来 */
function isMediaRequest(req) {
  try {
    const u = new URL(String((req && req.url) || ""));
    const p = String(u.pathname || "");
    return p === MEDIA_ROUTE || p.indexOf(MEDIA_ROUTE + "/") === 0;
  } catch (_) {
    return false;
  }
}

function plain(msg, status, extra) {
  const headers = Object.assign(
    { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    extra || {},
  );
  return new Response(String(msg), { status: status, headers: headers });
}

/* Range: bytes=start-end / bytes=start- / bytes=-suffix → { start, end } | { invalid:true } | null */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m) return null;
  let start = m[1] === "" ? null : Number(m[1]);
  let end = m[2] === "" ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    /* 后缀式：最后 N 字节 */
    const n = Number(end);
    if (!(n > 0)) return { invalid: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (!(start >= 0) || !(end >= start) || start >= size) return { invalid: true };
  return { start: start, end: end };
}

/* 媒体路由的处理：req → Response（字节流，支持 Range）。
   `?p=` 必须是**绝对路径**且扩展名在放行表里；其余一律 403 / 404，不回字节。 */
async function serveMediaRequest(req) {
  let abs = "";
  try {
    const u = new URL(String((req && req.url) || ""));
    abs = String(u.searchParams.get("p") || "").trim();
  } catch (_) {
    return plain("bad media url", 400);
  }
  if (!abs) return plain("missing p", 400);
  /* Windows 路径可能带正斜杠 / 盘符小写：统一交给 path.resolve 判绝对路径 */
  const full = path.resolve(abs);
  if (!path.isAbsolute(abs)) return plain("p must be absolute", 403);
  if (!isMediaPath(full)) return plain("not a media file", 403);
  let st = null;
  try {
    st = await fs.promises.stat(full);
  } catch (_) {
    return plain("media not found", 404);
  }
  if (!st.isFile()) return plain("not a file", 404);
  if (st.size > MEDIA_MAX_BYTES) return plain("media too large", 413);
  const type = MEDIA_MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
  const rangeHeader = (() => {
    try {
      return req && req.headers && typeof req.headers.get === "function" ? req.headers.get("range") : "";
    } catch (_) {
      return "";
    }
  })();
  const rg = parseRange(rangeHeader, st.size);
  if (rg && rg.invalid) {
    return plain("bad range", 416, { "content-range": "bytes */" + st.size });
  }
  if (rg) {
    const len = rg.end - rg.start + 1;
    return new Response(Readable.toWeb(fs.createReadStream(full, { start: rg.start, end: rg.end })), {
      status: 206,
      headers: {
        "content-type": type,
        "content-length": String(len),
        "content-range": "bytes " + rg.start + "-" + rg.end + "/" + st.size,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(full)), {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(st.size),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    },
  });
}

/* ── 页面侧：把播放条与它的桥补进 iframe ────────────────────────────── */

/* 宿主那条播放条（同一份实现）。读一次就缓存；`</script` 一律转义，免得把注入的
   <script> 提前闭合（播放条源码里本来也没有，但这里守一道）。 */
let playerCache = "";
function playerSource() {
  if (playerCache) return playerCache;
  let src = "";
  try {
    src = fs.readFileSync(path.join(__dirname, "renderer", "app-media-ui.js"), "utf8");
  } catch (_) {
    src = "";
  }
  playerCache = String(src).replace(/<\/script/gi, "<\\/script");
  return playerCache;
}

/* iframe 里那条「宿主桥」的小助手：与 preload-app.js 的 appHost.media.* 同形状。
   直接调同一个播放条（window.MTNodeMediaBar，由上面那份 playerSource 定义），
   所以播放 / 暂停 / 定位 / 音量 / 倍速 / 全屏的行为与独立窗口里逐字一致。
   写成真函数（不是字符串拼出来的代码）：测试里能直接拿它跑一遍。 */
function pageShim(win) {
  win = win || {};
  const host = win.appHost || (win.appHost = {});
  const loc = win.location || {};
  const route = "/__mtnode_media__";
  function urlOf(p) {
    const s = String(p == null ? "" : p).replace(/\\/g, "/");
    if (!s) return "";
    if (/^(data|blob|https?|mtnode-preview):/i.test(s)) return s;
    return "mtnode-preview://" + String(loc.hostname || "") + route + "/?p=" + encodeURIComponent(s);
  }
  function bar() {
    return win.MTNodeMediaBar || null;
  }
  function noPlayer() {
    return { ok: false, code: "no_player", error: "播放条没装上（preview-media.js 注入失败）" };
  }
  host.media = {
    urlOf: urlOf,
    play: function (opts) {
      const o = opts || {};
      const b = bar();
      if (!b || typeof b.play !== "function") return Promise.resolve(noPlayer());
      return Promise.resolve(b.play(String(o.path || ""), { title: o.title || "", kind: o.kind || "" }));
    },
    stop: function () {
      const b = bar();
      if (b && typeof b.stop === "function") b.stop();
      return Promise.resolve({ ok: true });
    },
    state: function () {
      const b = bar();
      if (!b || typeof b.state !== "function") return Promise.resolve(noPlayer());
      return Promise.resolve(b.state());
    },
    fullscreen: function (on) {
      const b = bar();
      if (b && typeof b.fullscreen === "function") b.fullscreen(!!on);
      return Promise.resolve({ ok: true });
    },
    /* iframe 里没有字节可解码（应用的 CSP connect-src 'none'，也不该为波形开个口子）：
       如实回 no_waveform，播放条画成普通进度条，点 / 拖定位照旧 */
    waveform: function () {
      return Promise.resolve({ ok: false, code: "no_waveform", peaks: [] });
    },
  };
  try {
    win.__mtnodeMediaHost = "preview";
  } catch (_) {}
  return host.media;
}

/* 小助手的源码形态（注入用） */
function shimSource() {
  return "(" + pageShim.toString() + ")(window);";
}

/* 注入 iframe 的那一整段（播放条 + 小助手）。apps-store.js 把这段与宿主桥拼进
   同一个 <script>（顺序：PREVIEW_BRIDGE → APPNODE_BRIDGE → 本段）。 */
function inlineSource() {
  return playerSource() + "\n" + shimSource();
}

module.exports = {
  MEDIA_ROUTE,
  MEDIA_MIME,
  IMAGE_MIME,
  MEDIA_MAX_BYTES,
  isMediaPath,
  isMediaRequest,
  parseRange,
  serveMediaRequest,
  playerSource,
  pageShim,
  shimSource,
  inlineSource,
};

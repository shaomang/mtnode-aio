"use strict";
/**
 * 全量更新包 → 多连接分段并发下载（含断点续传）。
 * 只依赖 node 内置模块（http / https / fs / crypto / path / url），**不 require electron**：
 * 这样它能在普通 node 里被单独驱动（量吞吐、验续传都一样），也便于排障。
 *
 * 为什么需要它：electron-updater 的全量兜底是 ElectronHttpExecutor.download —— 一条连接、
 * 一个 Content-Length、失败就整包重来。线上安装包约 165MB，单连接在弱网 / 抖动下就是
 * 「卡很久、然后失败」，重试还得从头开始。
 *
 * 它接管的入口（见 updater.js 的 installSegmentedFullDownload）：把
 * autoUpdater.httpExecutor.download 包一层，只在「带 sha512 + 目标是 .exe」这一种调用上
 * 切到这里 —— 也就是**只替换全量下载这一条路**。差分下载（DifferentialDownloader）走的是
 * httpExecutor.createRequest，完全不受影响。
 *
 * 机制：
 *   ① 探一次 Range: bytes=0-0，取总长与 ETag / Last-Modified，同时确认服务端给 206
 *      （nginx 那条链已实测 206 可用）；给 200 = 不支持 Range → 回 fallback，调用方退回原生下载。
 *   ② 按段切 [start, end]，每段独立 Range 请求、独立 .part 文件，最多 8 段并发。
 *   ③ 每次重试前按 .part 的实际字节数重算偏移 —— 断了从断点继续，不重下整包。
 *   ④ 全部段就绪后按顺序拼成 .full（边拼边删 .part，峰值占用 ≈ 一份包），整份 sha512 校验，
 *      对得上才 rename 到目标路径交给 electron-updater（它再 setDownloadedFile / quitAndInstall）。
 *      sha512 不对 → 清掉分段，绝不把坏包交给安装器。
 *
 * 分段文件放在 <cacheDir>/segments/（**不在** pending 里）：electron-updater 失败时会对
 * pending 做 emptyDir，放里面就等于每次失败都白下。7 天没动过的残留分段会在下次下载开头清掉。
 *
 * 开关（环境变量，便于回退）：
 *   MTNODE_UPDATE_SEGMENTS=6   段数（2–8；默认 6）
 *   MTNODE_UPDATE_SEGMENTS=1   关掉分段，回退 electron-updater 原生单连接（旧行为）
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const os = require("os");
const { URL } = require("url");

const DEFAULT_SEGMENTS = 6;
const MAX_SEGMENTS = 8;
/** 单段不小于 4MB：包小的时候少开几条连接，没必要为 3MB 的文件开 6 段 */
const MIN_SEGMENT_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const RETRIES_PER_SEGMENT = 3;
const RETRY_BASE_MS = 600;
const CONNECT_TIMEOUT_MS = 20000;
const IDLE_TIMEOUT_MS = 30000;
const PROGRESS_INTERVAL_MS = 200;
const PART_DIR_NAME = "segments";
const STALE_PART_MS = 7 * 24 * 3600 * 1000;

/** 连接层错误 → 直接判定「本机环境不适合自研下载」（代理 / 证书 / DNS），调用方退回原生下载 */
const FALLBACK_NET_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function segError(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampSegments(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_SEGMENTS;
  if (v <= 1) return 1; /* 0/1 = 关闭（回退单连接） */
  return Math.max(2, Math.min(MAX_SEGMENTS, Math.floor(v)));
}

/** 段数：环境变量 MTNODE_UPDATE_SEGMENTS（缺省 6；1 或 0 = 关闭） */
function segmentsFromEnv(env) {
  const src = env || process.env || {};
  const raw = String(src.MTNODE_UPDATE_SEGMENTS == null ? "" : src.MTNODE_UPDATE_SEGMENTS).trim();
  if (!raw) return DEFAULT_SEGMENTS;
  return clampSegments(raw);
}

/** 分段文件目录：优先 <cacheDir>/segments（destination 在 <cacheDir>/pending/ 下） */
function partDirFor(destination, explicit) {
  if (explicit) return explicit;
  try {
    const pendingDir = path.dirname(String(destination));
    if (path.basename(pendingDir).toLowerCase() === "pending")
      return path.join(path.dirname(pendingDir), PART_DIR_NAME);
  } catch (_) {}
  return path.join(os.tmpdir(), "mtnode-update-" + PART_DIR_NAME);
}

/**
 * 这一笔 httpExecutor.download 调用是不是「全量安装包」。
 * 判据三条同时成立：有 sha512（全量下载由 executeDownload 传入；差分 / blockmap 没有）、
 * 远端是 .exe、落盘也是 .exe。web installer 的 .7z 不接管。
 */
function isInstallerDownload(url, destination, options) {
  try {
    if (!options || !options.sha512) return false;
    const u = typeof url === "string" ? new URL(url) : url;
    const remote = String((u && (u.pathname || u.path)) || "");
    if (!/\.exe$/i.test(remote)) return false;
    return /\.exe$/i.test(String(destination || ""));
  } catch (_) {
    return false;
  }
}

function wrapNetError(e) {
  if (!e) return segError("SEG_NET", "下载失败");
  if (e.fallback) return e;
  const code = String(e.code || "");
  const extra = FALLBACK_NET_CODES.has(code) ? { fallback: true } : null;
  const msg =
    code === "ECONNRESET"
      ? "连接被重置（" + (e.message || "") + "）"
      : "网络错误：" + (e.message || code || "unknown");
  return segError("SEG_NET", msg, extra);
}

/** 一次 HTTP 请求（不解跟随重定向）：resolve 出 { req, res } */
function requestOnce(urlStr, headers, method) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (_) {
      return reject(segError("SEG_BAD_URL", "更新包地址非法：" + urlStr));
    }
    const mod = u.protocol === "http:" ? http : https;
    let req;
    try {
      req = mod.request(u, { method: method || "GET", headers }, (res) => resolve({ req, res }));
    } catch (e) {
      return reject(wrapNetError(e));
    }
    req.setTimeout(CONNECT_TIMEOUT_MS, () =>
      req.destroy(segError("SEG_TIMEOUT", "连接更新服务器超时")),
    );
    req.on("error", (e) => reject(wrapNetError(e)));
    req.end();
  });
}

/** 跟随 301/302/303/307/308（更新源 302 → OSS 是常态），返回最终那一次响应 */
async function requestFollowing(urlStr, headers, method) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await requestOnce(current, headers, method);
    const status = r.res.statusCode;
    const location = r.res.headers && r.res.headers.location;
    if (status >= 300 && status < 400 && location) {
      try {
        r.res.resume();
        r.req.destroy();
      } catch (_) {}
      try {
        current = new URL(location, current).href;
      } catch (_) {
        throw segError("SEG_BAD_REDIRECT", "更新源返回了非法跳转地址：" + location);
      }
      continue;
    }
    return r;
  }
  throw segError("SEG_TOO_MANY_REDIRECTS", "更新源跳转次数过多（>" + MAX_REDIRECTS + "）");
}

/** 探测：Range: bytes=0-0 → 206 + Content-Range，拿总长 / ETag */
async function probeRange(url, headers) {
  const h = Object.assign({}, headers, { Range: "bytes=0-0" });
  const { req, res } = await requestFollowing(url, h);
  const status = res.statusCode;
  const drop = () => {
    try {
      res.resume();
      req.destroy();
    } catch (_) {}
  };
  if (status === 200) {
    drop();
    return { ok: false, reason: "no_range_support" };
  }
  if (status !== 206) {
    drop();
    return { ok: false, reason: "http_" + status };
  }
  const cr = String(res.headers["content-range"] || "");
  const etag = String(res.headers.etag || "");
  const lastModified = String(res.headers["last-modified"] || "");
  drop();
  const m = cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
  const total = m ? Number(m[1]) : 0;
  if (!(total > 0)) return { ok: false, reason: "no_content_length" };
  return { ok: true, total, etag, lastModified };
}

function splitSpans(total, n) {
  const spans = [];
  let start = 0;
  const base = Math.floor(total / n);
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 ? total - start : base;
    spans.push({ start, end: start + len - 1, len });
    start += len;
  }
  return spans;
}

function partKey(destination, url, total, probe) {
  const name = path
    .basename(String(destination))
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 48);
  const h = crypto
    .createHash("sha1")
    .update(url + "|" + total + "|" + (probe.etag || probe.lastModified || ""))
    .digest("hex")
    .slice(0, 10);
  return name + "-" + h;
}

async function fileSize(p) {
  try {
    const st = await fsp.stat(p);
    return st.size;
  } catch (_) {
    return -1;
  }
}

async function sha512File(p) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    hash.setEncoding("base64");
    fs.createReadStream(p, { highWaterMark: 1024 * 1024 })
      .on("error", reject)
      .on("end", () => {
        hash.end();
        resolve(hash.read());
      })
      .pipe(hash, { end: false });
  });
}

function normalizeSha(v) {
  return String(v || "")
    .trim()
    .replace(/^sha512-/i, "");
}

/** 清掉 7 天没动过的其它任务残留分段（同一个 key 的不动，那是本次要续传的） */
async function sweepStale(partDir, keepPrefix) {
  let names = [];
  try {
    names = await fsp.readdir(partDir);
  } catch (_) {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (keepPrefix && name.startsWith(keepPrefix)) continue;
    const p = path.join(partDir, name);
    try {
      const st = await fsp.stat(p);
      if (now - st.mtimeMs > STALE_PART_MS) {
        await fsp.unlink(p);
        removed++;
      }
    } catch (_) {}
  }
  return removed;
}

async function resetPart(st) {
  st.got = 0;
  await fsp.unlink(st.path).catch(() => {});
}

/** 下完一段就落满 st.len；断在中间则按文件实际字节数留作下次的起点 */
async function fetchSegment(ctx, st) {
  for (let attempt = 0; ; attempt++) {
    if (ctx.cancelled()) throw segError("SEG_CANCELLED", "下载已取消");
    try {
      const r = await fetchOnce(ctx, st);
      if (r === "reset") {
        await resetPart(st);
        continue;
      }
      const size = await fileSize(st.path);
      st.got = size > 0 ? Math.min(size, st.len) : 0;
      if (st.got >= st.len) {
        st.done = true;
        return;
      }
      throw segError("SEG_SHORT_READ", "分段未下满（" + st.got + "/" + st.len + "）");
    } catch (e) {
      if (e && (e.code === "SEG_CANCELLED" || e.fallback)) throw e;
      if (attempt >= RETRIES_PER_SEGMENT) throw e;
      await sleep(RETRY_BASE_MS * (attempt + 1));
      const size = await fileSize(st.path);
      st.got = size > 0 ? Math.min(size, st.len) : 0;
      if (st.got >= st.len) {
        st.done = true;
        return;
      }
    }
  }
}

async function fetchOnce(ctx, st) {
  const from = st.start + st.got;
  const to = st.end;
  const headers = Object.assign({}, ctx.headers, { Range: "bytes=" + from + "-" + to });
  const r = await requestFollowing(ctx.url, headers);
  const res = r.res;
  const drop = (err) => {
    try {
      res.resume();
      r.req.destroy();
    } catch (_) {}
    if (err) throw err;
  };
  if (res.statusCode === 416) {
    drop();
    return "reset";
  }
  if (res.statusCode !== 206) {
    drop(
      segError(
        "SEG_BAD_RANGE_STATUS",
        "更新服务器对分段请求返回 HTTP " + res.statusCode + "（需要 206）",
        { fallback: res.statusCode === 200 },
      ),
    );
  }
  const cr = String(res.headers["content-range"] || "");
  const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
  if (m && Number(m[1]) !== from) {
    drop();
    return "reset";
  }
  /* 响应超时按「停顿」算：30s 一个字节都没有就判这一段失败，交给重试去续 */
  try {
    r.req.setTimeout(IDLE_TIMEOUT_MS, () =>
      r.req.destroy(segError("SEG_IDLE_TIMEOUT", "下载停顿超过 " + IDLE_TIMEOUT_MS / 1000 + "s")),
    );
  } catch (_) {}
  ctx.requests.add(r.req);
  const out = fs.createWriteStream(st.path, { flags: st.got > 0 ? "a" : "w" });
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try {
          out.destroy();
        } catch (_) {}
        try {
          r.req.destroy();
        } catch (_) {}
        reject(e);
      };
      res.on("data", (chunk) => {
        if (ctx.cancelled()) return fail(segError("SEG_CANCELLED", "下载已取消"));
        st.got += chunk.length;
        ctx.emit();
      });
      res.on("error", (e) => fail(wrapNetError(e)));
      res.on("aborted", () => fail(segError("SEG_ABORTED", "连接被中断")));
      out.on("error", (e) =>
        fail(segError("SEG_WRITE_FAILED", "写入分段文件失败：" + (e.message || e))),
      );
      out.on("finish", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      res.pipe(out);
    });
  } finally {
    ctx.requests.delete(r.req);
  }
  return "ok";
}

async function appendPart(out, filePath) {
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    rs.on("error", reject);
    rs.on("end", resolve);
    rs.pipe(out, { end: false });
  });
}

/** 落盘：Windows 上 rename 到已存在 / 被占用的路径会 EBUSY，按 200ms 重试共 10s */
async function placeFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.unlink(to).catch(() => {});
  for (let i = 0; i < 50; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = String((e && e.code) || "");
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        await sleep(200);
        continue;
      }
      throw segError("SEG_PLACE_FAILED", "分段下载已完成但落盘失败：" + (e.message || e));
    }
  }
  throw segError("SEG_PLACE_FAILED", "分段下载已完成但目标文件被占用，落盘失败");
}

/**
 * 分段下载。
 * @param {object} opts
 *   url         远端 .exe 地址（http/https，可带 302）
 *   destination 目标文件（electron-updater 给的临时文件路径）
 *   sha512      latest.yml 里的 base64 sha512（可选；有则必须对上）
 *   segments    段数（可选；缺省读 MTNODE_UPDATE_SEGMENTS）
 *   headers     请求头（沿用 electron-updater 算好的那份）
 *   onProgress  ({total, transferred, percent, bytesPerSecond, delta}) => void
 *   cancellationToken  builder-util-runtime 的 CancellationToken
 *   partDir     分段目录（可选；缺省 <cacheDir>/segments）
 * @returns {Promise<object>} ok:true 时目标文件已就绪且 sha512 已校验；
 *          ok:false + fallback:true 表示「环境不支持」，调用方应退回原生单连接下载。
 */
async function downloadSegmented(opts) {
  const o = opts || {};
  const url = String(o.url || "");
  const destination = String(o.destination || "");
  if (!url || !destination)
    throw segError("SEG_BAD_ARGS", "分段下载缺少 url / destination");
  const wantSegs = o.segments != null ? clampSegments(o.segments) : segmentsFromEnv(o.env);
  if (wantSegs <= 1) return { ok: false, fallback: true, reason: "disabled" };

  const headers = Object.assign(
    { "Accept-Encoding": "identity", "Cache-Control": "no-cache" },
    o.headers || {},
  );
  const token = o.cancellationToken || null;
  const requests = new Set();
  const cancelled = () => {
    try {
      return !!(token && token.cancelled);
    } catch (_) {
      return false;
    }
  };
  if (token && typeof token.onCanceled === "function") {
    token.onCanceled(() => {
      for (const req of requests) {
        try {
          req.destroy(segError("SEG_CANCELLED", "下载已取消"));
        } catch (_) {}
      }
    });
  }

  const startedAt = Date.now();
  const probe = await probeRange(url, headers);
  if (!probe.ok) return { ok: false, fallback: true, reason: probe.reason };
  const total = probe.total;
  const segCount = Math.max(1, Math.min(wantSegs, Math.ceil(total / MIN_SEGMENT_BYTES)));
  const spans = splitSpans(total, segCount);

  const partDir = partDirFor(destination, o.partDir);
  await fsp.mkdir(partDir, { recursive: true });
  const key = partKey(destination, url, total, probe);
  const metaPath = path.join(partDir, key + ".json");
  const mergedPath = path.join(partDir, key + ".full");
  await sweepStale(partDir, key);
  try {
    await fsp.writeFile(
      metaPath,
      JSON.stringify({
        v: 1,
        url,
        destination,
        total,
        etag: probe.etag,
        lastModified: probe.lastModified,
        segments: segCount,
        at: new Date().toISOString(),
      }),
    );
  } catch (_) {}

  const states = spans.map((sp, i) => ({
    index: i,
    start: sp.start,
    end: sp.end,
    len: sp.len,
    got: 0,
    done: false,
    path: path.join(partDir, key + "." + i + ".part"),
  }));

  /* 上次已经拼到 .full 里的部分：按「累计长度 ≤ .full 实际大小」认前缀，多出来的尾巴截掉 */
  let mergedBytes = await fileSize(mergedPath);
  if (mergedBytes < 0) mergedBytes = 0;
  let mergedLen = 0;
  let mergedThrough = 0;
  for (const st of states) {
    if (mergedLen + st.len <= mergedBytes) {
      mergedLen += st.len;
      mergedThrough++;
    } else break;
  }
  if (mergedBytes !== mergedLen) await fsp.truncate(mergedPath, mergedLen).catch(() => {});
  mergedBytes = mergedLen;
  for (let i = 0; i < mergedThrough; i++) {
    states[i].done = true;
    states[i].got = states[i].len;
    await fsp.unlink(states[i].path).catch(() => {});
  }

  /* 各段起点 = 已有 .part 的实际字节数（断点续传就在这里） */
  let resumedBytes = mergedBytes;
  for (let i = mergedThrough; i < states.length; i++) {
    const st = states[i];
    const size = await fileSize(st.path);
    if (size > st.len) await fsp.truncate(st.path, st.len).catch(() => {});
    st.got = size > 0 ? Math.min(size, st.len) : 0;
    if (st.got >= st.len) st.done = true;
    resumedBytes += st.got;
  }

  /* 进度：已合并 + 各段已下；速度取 500ms 窗口的平滑值 */
  let lastEmitAt = 0;
  let lastSampleAt = Date.now();
  let lastSampleBytes = mergedBytes;
  let speed = 0;
  let lastDelta = 0;
  let lastTransferred = 0;
  const doneBytes = () => {
    let sum = mergedBytes;
    for (const st of states) sum += st.done ? st.len : st.got;
    return sum;
  };
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_INTERVAL_MS) return;
    lastEmitAt = now;
    const transferred = doneBytes();
    if (now - lastSampleAt >= 500) {
      const dt = Math.max(0.001, (now - lastSampleAt) / 1000);
      const inst = Math.max(0, (transferred - lastSampleBytes) / dt);
      speed = speed > 0 ? speed * 0.6 + inst * 0.4 : inst;
      lastSampleAt = now;
      lastSampleBytes = transferred;
    }
    lastDelta = Math.max(0, transferred - lastTransferred);
    lastTransferred = transferred;
    const p = {
      total,
      transferred,
      percent: total > 0 ? (transferred * 100) / total : 0,
      delta: lastDelta,
      bytesPerSecond: Math.round(speed),
    };
    try {
      if (typeof o.onProgress === "function") o.onProgress(p);
    } catch (_) {}
  };
  const ctx = { url, headers, requests, cancelled, emit };

  emit(true);
  const pending = states.filter((st) => !st.done);
  try {
    let cursor = 0;
    const workers = Math.max(1, Math.min(pending.length, MAX_SEGMENTS));
    const run = async () => {
      while (cursor < pending.length) {
        const st = pending[cursor++];
        await fetchSegment(ctx, st);
      }
    };
    const pool = [];
    for (let i = 0; i < workers; i++) pool.push(run());
    await Promise.all(pool);
  } catch (e) {
    /* 失败时把已下的留在 <cacheDir>/segments/ 里，下次同一 URL 续传 */
    throw e;
  }
  emit(true);

  /* 拼包：按顺序 append 到 .full，拼完一段删一段（峰值占用 ≈ 一份包） */
  const out = fs.createWriteStream(mergedPath, { flags: mergedBytes > 0 ? "a" : "w" });
  try {
    for (let i = mergedThrough; i < states.length; i++) {
      await appendPart(out, states[i].path);
      await fsp.unlink(states[i].path).catch(() => {});
      mergedLen += states[i].len;
    }
  } finally {
    await new Promise((resolve) => out.end(() => resolve()));
  }
  const mergedSize = await fileSize(mergedPath);
  if (mergedSize !== total)
    throw segError(
      "SEG_INCOMPLETE",
      "分段合并后大小不符：" + mergedSize + "/" + total + "（分段已保留，可重试续传）",
    );

  const wantSha = normalizeSha(o.sha512);
  let verified = false;
  if (wantSha) {
    const got = await sha512File(mergedPath);
    if (got !== wantSha) {
      await fsp.unlink(mergedPath).catch(() => {});
      for (const st of states) await fsp.unlink(st.path).catch(() => {});
      throw segError(
        "SEG_SHA512_MISMATCH",
        "分段下载完成但 sha512 校验失败（不会交给安装器，已清掉分段重来）",
      );
    }
    verified = true;
  }

  await placeFile(mergedPath, destination);
  await fsp.unlink(metaPath).catch(() => {});
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  return {
    ok: true,
    bytes: total,
    segments: segCount,
    resumedBytes,
    elapsedMs,
    bytesPerSecond: Math.round((total * 1000) / elapsedMs),
    verified,
    partDir,
  };
}

module.exports = {
  downloadSegmented,
  segmentsFromEnv,
  isInstallerDownload,
  partDirFor,
  DEFAULT_SEGMENTS,
  MAX_SEGMENTS,
};

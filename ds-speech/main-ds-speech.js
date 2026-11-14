"use strict";
/**
 * DeepSeek 云端语音（主进程宿主）：语音合成 TTS + 语音识别 ASR
 * ----------------------------------------------------------------------------
 * 官方文档（本文件的唯一口径来源，字段与限制逐条对应，改口径先改文档）：
 *   · 语音合成  https://api-docs.deepseek.com/zh-cn/guides/tts
 *       POST https://api.deepseek.com/v1/tools/tts        （整段：要么听要么不听）
 *       WSS  wss://api.deepseek.com/v1/tools/tts          （流式：分片出音频帧）
 *       请求体 / 查询参数：text（≤10000 计费字符、请求体 ≤64KiB）、voice_id（stella 默认 / tide）、
 *       format（整段 wav 默认 | pcm；流式 pcm 默认 | opus）、filter_markdown（默认 true）
 *       状态码：400 无可朗读文本 / 内容审核不过（Content Exists Risk）· 429 并发超限
 *               · 503 服务繁忙 · 504 合成超时
 *   · 语音识别  https://api-docs.deepseek.com/zh-cn/guides/asr
 *       POST https://api.deepseek.com/v1/tools/asr
 *       multipart/form-data 的 file 字段：16 位 PCM WAV 或 Ogg Opus；WAV 采样率 8000/16000/
 *       22050/24000/32000/44100/48000；单 / 双声道（双声道只识左声道）；≤8 MiB；≤120 秒。
 *       返回 { request_id, text, duration_ms }。
 *       状态码：400 音频格式不对 / 缺 file · 408 上传超时 · 413 文件过大
 *               · 429 并发超限 · 503 繁忙 · 504 识别超时。
 *
 * 纪律：
 *   ① **只用官方 DeepSeek 提供商**：baseUrl / apiKey 由调用方（渲染层的官方那条提供商）传进来，
 *      这里不接受任意第三方 baseUrl 之外的额外鉴权（没有第二种鉴权方式）。
 *   ② 主进程不做文本切分、不做音频切分 —— 切分口径在渲染层（与话筒听写同一套「静音断句」），
 *      这里只负责「一次请求 = 一段文本 / 一段音频」。
 *   ③ 二进制不经过 JSON：TTS 直接落盘并回路径；ASR 由渲染层给 base64（16k 单声道 WAV）。
 *   ④ 数据落点：调用方给了 outPath 就写那里；没给就写系统临时目录下的 mtnode-ds-tts/
 *      （**绝不写应用目录**，见 AGENTS.md）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

const DEFAULT_BASE = "https://api.deepseek.com";
const TTS_PATH = "/v1/tools/tts";
const ASR_PATH = "/v1/tools/asr";
const TTS_SAMPLE_RATE = 24000; /* 文档：pcm = 24 kHz、16 位、单声道 */
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TTS_CHARS = 10000;
const ASR_MAX_BYTES = 8 * 1024 * 1024;

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function normBase(p) {
  const raw = String((p && p.baseUrl) || "").trim() || DEFAULT_BASE;
  /* 提供商里可能填成 https://api.deepseek.com/v1（OpenAI 兼容习惯）：工具 API 的路径
     自带 /v1 前缀，这里把末尾的 /v1 与斜杠都剥掉，避免拼出 /v1/v1/tools/tts */
  return raw
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "");
}

function keyOf(p) {
  return String((p && p.apiKey) || "").trim();
}

/** 48 字节头（44 + 0 填充）的 16 位 PCM WAV；pcmBytes 已知就一次写完，未知先占位 */
function wavHeader(byteLen, sampleRate, channels) {
  const ch = channels || 1;
  const rate = sampleRate || TTS_SAMPLE_RATE;
  const bits = 16;
  const blockAlign = (ch * bits) / 8;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + byteLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); /* fmt 块长度 */
  buf.writeUInt16LE(1, 20); /* PCM */
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(byteLen, 40);
  return buf;
}

/** 回填 WAV 头（data 长度已知：流式收完 / 整段 pcm 收完时用） */
function patchWavHeader(fd, byteLen, sampleRate) {
  const head = wavHeader(byteLen, sampleRate);
  fs.writeSync(fd, head, 0, head.length, 0);
}

function ensureDirFor(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch {}
}

function tmpOutPath(ext) {
  const dir = path.join(os.tmpdir(), "mtnode-ds-tts");
  ensureDirFor(path.join(dir, "x"));
  const name =
    "ds_tts_" +
    new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19) +
    "_" +
    Math.random().toString(36).slice(2, 6) +
    (ext || ".wav");
  return path.join(dir, name);
}

/** 官方错误体 → 人话（返回 {code, message}；message 原样给渲染层做兜底诊断） */
function mapHttpError(status, bodyText) {
  let detail = "";
  try {
    const j = JSON.parse(bodyText);
    detail =
      (j && j.error && (j.error.message || j.error.code)) ||
      (j && (j.message || j.detail)) ||
      "";
  } catch {
    detail = String(bodyText || "").slice(0, 300);
  }
  detail = String(detail || "");
  const risk = /content\s*exists\s*risk|content_filter|内容审核/i.test(detail);
  let code = "http_" + status;
  if (status === 400) code = risk ? "content_risk" : "bad_request";
  else if (status === 401 || status === 403) code = "bad_key";
  else if (status === 408) code = "upload_timeout";
  else if (status === 413) code = "too_large";
  else if (status === 429) code = "rate_limited";
  else if (status === 503) code = "busy";
  else if (status === 504) code = "timeout";
  return { code, message: detail };
}

function fail(code, message) {
  return { ok: false, code: String(code || "error"), message: String(message || "") };
}

/* ── 整段合成（POST /v1/tools/tts）───────────────────────────────────────────
 * 音频边合成边返回，所以这里是「边收边写」：wav 原样落盘；pcm 先写 44 字节占位头，
 * 收完再回填长度（用户中途取消 / 断流时文件也不会是 0 字节的空壳）。
 * 依赖：文本 ≤10000 计费字符、请求体 ≤64KiB —— 超了直接拒，不去猜服务端会不会截断。
 */
function ttsWhole(opts) {
  const o = opts || {};
  const base = normBase(o.provider);
  const key = keyOf(o.provider);
  const text = String(o.text || "");
  const voiceId = String(o.voiceId || "stella").trim() || "stella";
  const fmt = String(o.format || "wav").toLowerCase() === "pcm" ? "pcm" : "wav";
  const filterMarkdown = o.filterMarkdown === undefined ? true : !!o.filterMarkdown;
  if (!key) return Promise.resolve(fail("no_key", "未配置 DeepSeek API Key"));
  if (!text.trim()) return Promise.resolve(fail("empty_text", "没有可朗读的文本"));
  if (text.length > MAX_TTS_CHARS)
    return Promise.resolve(
      fail("text_too_long", "文本超过 " + MAX_TTS_CHARS + " 个计费字符（当前 " + text.length + "）"),
    );

  const outPath = String(o.outPath || "").trim() || tmpOutPath(".wav");
  ensureDirFor(outPath);
  const payload = Buffer.from(
    JSON.stringify({
      text: text,
      voice_id: voiceId,
      format: fmt,
      filter_markdown: filterMarkdown,
    }),
    "utf8",
  );
  if (payload.length > 64 * 1024)
    return Promise.resolve(fail("text_too_long", "请求体超过 64 KiB（文本太长，请分段）"));

  const u = new URL(base + TTS_PATH);
  const lib = u.protocol === "https:" ? https : http;
  const timeoutMs = Math.max(5000, Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS);

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const rq = lib.request(
      u,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Accept: "*/*",
        },
      },
      (res) => {
        const status = Number(res.statusCode) || 0;
        if (status >= 400) {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const m = mapHttpError(status, Buffer.concat(chunks).toString("utf8"));
            done(fail(m.code, m.message));
          });
          return;
        }
        let fd = null;
        let written = 0;
        try {
          fd = fs.openSync(outPath, "w");
          if (fmt === "pcm") fs.writeSync(fd, wavHeader(0, TTS_SAMPLE_RATE), 0, 44, 0);
        } catch (e) {
          done(fail("write_failed", "写不了输出文件：" + ((e && e.message) || e)));
          try {
            res.destroy();
          } catch {}
          return;
        }
        res.on("data", (chunk) => {
          try {
            fs.writeSync(fd, chunk, 0, chunk.length, null);
            written += chunk.length;
          } catch (e) {
            try {
              res.destroy();
            } catch {}
            done(fail("write_failed", "写输出文件失败：" + ((e && e.message) || e)));
          }
        });
        res.on("aborted", () => {
          /* 文档：音频开始返回后失败会中途断开 —— 提前结束的响应视为失败 */
          try {
            fs.closeSync(fd);
          } catch {}
          fd = null;
          done(fail("stream_aborted", "合成中途断开（服务端返回不完整音频）"));
        });
        res.on("end", () => {
          if (!fd) return;
          try {
            if (fmt === "pcm") patchWavHeader(fd, written, TTS_SAMPLE_RATE);
            fs.closeSync(fd);
            fd = null;
          } catch {}
          if (!written) return done(fail("empty_audio", "服务端没有返回音频数据"));
          done({
            ok: true,
            path: outPath,
            bytes: written + (fmt === "pcm" ? 44 : 0),
            format: fmt,
            voiceId: voiceId,
          });
        });
      },
    );
    const timer = setTimeout(() => {
      try {
        rq.destroy(new Error("timeout"));
      } catch {}
      done(fail("timeout", "合成超时（" + Math.round(timeoutMs / 1000) + " 秒）"));
    }, timeoutMs);
    rq.on("error", (e) => {
      clearTimeout(timer);
      if (settled) return;
      const msg = String((e && e.message) || e);
      done(fail(/timeout/i.test(msg) ? "timeout" : "network", msg));
    });
    rq.on("close", () => clearTimeout(timer));
    rq.write(payload);
    rq.end();
  });
}

/* ── 流式合成（WSS /v1/tools/tts）──────────────────────────────────────────
 * 鉴权：文档给两条路 —— Authorization 头，或子协议 `tts, bearer.<API Key>`。
 * 主进程的 WebSocket 是 Node 内置实现（WHATWG 口径，只认 (url, protocols)），
 * 所以这里走**子协议**那条（与文档示例等价），不依赖 undici 的扩展参数。
 * onPcm(buf) 收到的是裸 24k/16bit/单声道 PCM 帧。
 */
function ttsStream(opts) {
  const o = opts || {};
  const base = normBase(o.provider);
  const key = keyOf(o.provider);
  const text = String(o.text || "");
  const voiceId = String(o.voiceId || "stella").trim() || "stella";
  const fmt = String(o.format || "pcm").toLowerCase() === "wav" ? "wav" : "pcm";
  const filterMarkdown = o.filterMarkdown === undefined ? true : !!o.filterMarkdown;
  const onPcm = typeof o.onPcm === "function" ? o.onPcm : () => {};
  if (!key) return Promise.resolve(fail("no_key", "未配置 DeepSeek API Key"));
  if (!text.trim()) return Promise.resolve(fail("empty_text", "没有可朗读的文本"));
  if (text.length > MAX_TTS_CHARS)
    return Promise.resolve(fail("text_too_long", "文本超过 " + MAX_TTS_CHARS + " 个计费字符"));
  if (typeof WebSocket !== "function")
    return Promise.resolve(fail("no_websocket", "本机 Electron 没有内置 WebSocket（需要 ≥28）"));

  const wsBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const qs =
    "?voice_id=" +
    encodeURIComponent(voiceId) +
    "&format=" +
    encodeURIComponent(fmt) +
    "&filter_markdown=" +
    (filterMarkdown ? "true" : "false");
  const timeoutMs = Math.max(5000, Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS);

  return new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    let ws = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws) ws.close();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(
      () => finish(fail("timeout", "流式合成超时（" + Math.round(timeoutMs / 1000) + " 秒）")),
      timeoutMs,
    );
    try {
      ws = new WebSocket(wsBase + TTS_PATH + qs, ["tts", "bearer." + key]);
    } catch (e) {
      return finish(fail("no_websocket", String((e && e.message) || e)));
    }
    try {
      ws.binaryType = "arraybuffer";
    } catch {}
    ws.onopen = () => {
      try {
        /* 文档：JSON 文本消息逐段发文字，最后一段之后发 finish_text。
           这里把整段按 ≤1000 字切开发（同一会话内的分片，服务端会按顺序念）。 */
        const step = 1000;
        for (let i = 0; i < text.length; i += step) {
          ws.send(JSON.stringify({ event: "text", text: text.slice(i, i + step) }));
        }
        ws.send(JSON.stringify({ event: "finish_text" }));
      } catch (e) {
        finish(fail("network", String((e && e.message) || e)));
      }
    };
    ws.onmessage = (ev) => {
      const data = ev && ev.data;
      if (typeof data === "string") {
        let j = null;
        try {
          j = JSON.parse(data);
        } catch {
          j = null;
        }
        if (j && j.event === "finish") {
          const code = String(j.code || "");
          if (code === "success") finish({ ok: true, bytes: bytes, format: fmt, voiceId: voiceId });
          else finish(fail("ws_" + code, String(j.message || code)));
        }
        return;
      }
      /* 二元消息 = 音频帧（ArrayBuffer / TypedArray / Blob 三种形态都兜住） */
      try {
        if (data && typeof data.arrayBuffer === "function") {
          data.arrayBuffer().then((ab) => {
            const buf = Buffer.from(ab);
            bytes += buf.length;
            onPcm(buf);
          });
          return;
        }
        const buf = Buffer.from(data);
        bytes += buf.length;
        onPcm(buf);
      } catch {}
    };
    ws.onerror = () => finish(fail("network", "流式连接出错（检查网络 / Key / 并发上限）"));
    ws.onclose = () => finish(fail("network", "流式连接在 finish 之前被关闭"));
  });
}

/* ── 语音识别（POST /v1/tools/asr）───────────────────────────────────────────
 * 文档只收 16 位 PCM WAV 或 Ogg Opus；这里只走 WAV（渲染层把音频解成 16k 单声道 WAV）。
 * 文档上限 8 MiB / 120 秒 —— 切分口径在渲染层（静音断句 + 硬顶），这里只守一道闸：
 * 超了直接拒，绝不上传一份自己都知道会被 413 / 400 打回的文件。
 */
function asrOnce(opts) {
  const o = opts || {};
  const base = normBase(o.provider);
  const key = keyOf(o.provider);
  if (!key) return Promise.resolve(fail("no_key", "未配置 DeepSeek API Key"));
  let audio = null;
  try {
    audio = Buffer.from(String(o.audioBase64 || ""), "base64");
  } catch {
    audio = null;
  }
  if (!audio || !audio.length) return Promise.resolve(fail("bad_audio", "没有可识别的音频"));
  if (audio.length > ASR_MAX_BYTES)
    return Promise.resolve(
      fail("too_large", "音频 " + (audio.length / 1048576).toFixed(1) + " MiB，超过 8 MiB 上限"),
    );

  const boundary = "----mtnode" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const head = Buffer.from(
    "--" +
      boundary +
      "\r\n" +
      'Content-Disposition: form-data; name="file"; filename="' +
      String(o.filename || "speech.wav").replace(/["\r\n]/g, "") +
      '"\r\n' +
      "Content-Type: audio/wav\r\n\r\n",
    "utf8",
  );
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n", "utf8");
  const body = Buffer.concat([head, audio, tail]);

  const u = new URL(base + ASR_PATH);
  const lib = u.protocol === "https:" ? https : http;
  const timeoutMs = Math.max(5000, Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const rq = lib.request(
      u,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "multipart/form-data; boundary=" + boundary,
          "Content-Length": body.length,
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const status = Number(res.statusCode) || 0;
          const text = Buffer.concat(chunks).toString("utf8");
          if (status >= 400) {
            const m = mapHttpError(status, text);
            return done(fail(m.code, m.message));
          }
          let j = null;
          try {
            j = JSON.parse(text);
          } catch {
            return done(fail("bad_response", String(text || "").slice(0, 300)));
          }
          done({
            ok: true,
            text: String((j && j.text) || "").trim(),
            durationMs: Number((j && j.duration_ms) || 0),
            requestId: String((j && j.request_id) || ""),
          });
        });
      },
    );
    const timer = setTimeout(() => {
      try {
        rq.destroy(new Error("timeout"));
      } catch {}
      done(fail("timeout", "识别超时（" + Math.round(timeoutMs / 1000) + " 秒）"));
    }, timeoutMs);
    rq.on("error", (e) => {
      clearTimeout(timer);
      const msg = String((e && e.message) || e);
      done(fail(/timeout/i.test(msg) ? "timeout" : "network", msg));
    });
    rq.on("close", () => clearTimeout(timer));
    rq.write(body);
    rq.end();
  });
}

/* ── 合成节点用：一个文本 → 一个 wav 文件 ─────────────────────────────────
 * 文档口径：一次请求的 text ≤10000 计费字符（请求体 ≤64KiB）。节点正文可能更长，
 * 所以这里按**句末标点**切段（不是按字节硬砍，避免把一句话砍成两半念断），
 * 逐段合成、逐段抽 PCM，最后拼成一个 wav（24kHz / 16bit / 单声道，服务端原样）。
 * 好处：单段失败就整次失败并报清「第几段」，绝不拿半份音频冒充整段。
 */
function splitForTts(text, maxChars) {
  const cap = Math.max(200, Number(maxChars) || 9000);
  const src = String(text || "");
  if (src.length <= cap) return [src];
  const out = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur);
    cur = "";
  };
  /* 先按句末标点切，再按 cap 累积 */
  const pieces = src.split(/(?<=[。！？!?；;…\n])/);
  for (const p of pieces) {
    if (!p) continue;
    if ((cur + p).length > cap) push();
    if (p.length > cap) {
      /* 单句就超了：按 cap 硬切（极端情况，保证能发出去） */
      for (let i = 0; i < p.length; i += cap) {
        const s = p.slice(i, i + cap);
        if ((cur + s).length > cap) push();
        cur += s;
        if (cur.length >= cap) push();
      }
      continue;
    }
    cur += p;
  }
  push();
  return out.length ? out : [src.slice(0, cap)];
}

/** 从一份 wav 里取出 data 块（TTS 回的 wav 由服务端封装，块顺序与本机不同） */
function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("不是合法的 WAV 数据");
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "data") return buf.subarray(body, Math.min(buf.length, body + size));
    off = body + size + (size % 2); /* chunk 按 2 字节对齐 */
  }
  throw new Error("WAV 里没有 data 块");
}

/** 流式合成 → 写一个 wav 文件（onPcm 顺手可以推给界面） */
function ttsStreamToFile(opts) {
  const o = opts || {};
  const outPath = String(o.outPath || "").trim() || tmpOutPath(".wav");
  ensureDirFor(outPath);
  const fd = fs.openSync(outPath, "w");
  fs.writeSync(fd, wavHeader(0, TTS_SAMPLE_RATE), 0, 44, 0);
  let bytes = 0;
  let writeErr = null;
  return ttsStream({
    provider: o.provider,
    text: o.text,
    voiceId: o.voiceId,
    format: "pcm",
    filterMarkdown: o.filterMarkdown,
    timeoutMs: o.timeoutMs,
    onPcm: (buf) => {
      if (writeErr) return;
      try {
        fs.writeSync(fd, buf, 0, buf.length, null);
        bytes += buf.length;
      } catch (e) {
        writeErr = e;
      }
      if (typeof o.onPcm === "function") o.onPcm(buf);
    },
  }).then((r) => {
    try {
      if (!writeErr && r && r.ok) patchWavHeader(fd, bytes, TTS_SAMPLE_RATE);
      fs.closeSync(fd);
    } catch {}
    if (writeErr) return fail("write_failed", "写输出文件失败：" + (writeErr.message || writeErr));
    if (!r || !r.ok) {
      try {
        fs.unlinkSync(outPath);
      } catch {}
      return r || fail("error", "流式合成失败");
    }
    if (!bytes) {
      try {
        fs.unlinkSync(outPath);
      } catch {}
      return fail("empty_audio", "服务端没有返回音频数据");
    }
    return { ok: true, path: outPath, bytes: bytes + 44, format: "wav", stream: true, voiceId: o.voiceId };
  });
}

/**
 * 节点用：整段 / 流式都落到**一个 wav 文件**。
 * opts: { provider, text, voiceId, format('wav'|'pcm'), filterMarkdown, stream, outPath, timeoutMs }
 */
async function ttsFile(opts) {
  const o = opts || {};
  const key = keyOf(o.provider);
  if (!key) return fail("no_key", "未配置 DeepSeek API Key");
  const text = String(o.text || "");
  if (!text.trim()) return fail("empty_text", "没有可朗读的文本");
  const outPath = String(o.outPath || "").trim() || tmpOutPath(".wav");
  ensureDirFor(outPath);
  const segs = splitForTts(text, MAX_TTS_CHARS - 500);
  const fd = fs.openSync(outPath, "w");
  fs.writeSync(fd, wavHeader(0, TTS_SAMPLE_RATE), 0, 44, 0);
  let total = 0;
  let used = 0;
  try {
    for (let i = 0; i < segs.length; i++) {
      const tmp = tmpOutPath(".wav");
      const r = o.stream
        ? await ttsStreamToFile({
            provider: o.provider,
            text: segs[i],
            voiceId: o.voiceId,
            filterMarkdown: o.filterMarkdown,
            outPath: tmp,
            timeoutMs: o.timeoutMs,
          })
        : await ttsWhole({
            provider: o.provider,
            text: segs[i],
            voiceId: o.voiceId,
            format: o.format,
            filterMarkdown: o.filterMarkdown,
            outPath: tmp,
            timeoutMs: o.timeoutMs,
          });
      if (!r || !r.ok) {
        const e = Object.assign({}, r || {});
        e.message = (r && r.message) || "";
        e.segment = i + 1;
        e.segments = segs.length;
        return e;
      }
      const pcm = readWavPcm(r.path);
      fs.writeSync(fd, pcm, 0, pcm.length, null);
      total += pcm.length;
      used++;
      try {
        fs.unlinkSync(r.path);
      } catch {}
    }
    patchWavHeader(fd, total, TTS_SAMPLE_RATE);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(outPath);
    } catch {}
    return fail("error", String((e && e.message) || e));
  }
  try {
    fs.closeSync(fd);
  } catch {}
  if (!total) return fail("empty_audio", "服务端没有返回音频数据");
  return {
    ok: true,
    path: outPath,
    bytes: total + 44,
    format: "wav",
    requestedFormat: String(o.format || "wav").toLowerCase() === "pcm" ? "pcm" : "wav",
    stream: !!o.stream,
    voiceId: String(o.voiceId || "stella"),
    segments: used,
    durationSec: Math.round((total / 2 / TTS_SAMPLE_RATE) * 10) / 10,
  };
}

/* ── IPC 接线 ───────────────────────────────────────────────────────────────
 * 三个入口一一对应上面三个能力；流式还要一条「往渲染层推 PCM 帧」的通道
 * （状态栏语音播报用它边合成边播）。会话 id 由渲染层给，取消按 id 关连接。
 */
const streams = new Map(); /* session → { cancelled:true } */

function registerDsSpeechIpc(opts) {
  const o = opts || {};
  /* electron 延后到接线时 require：本文件的能力函数（ttsWhole / ttsStream / asrOnce）
     在纯 Node 下也能直接跑，test/smoke-ds-speech.js 就靠这一点做真调冒烟。 */
  const { ipcMain } = require("electron");

  ipcMain.handle("dsSpeech:tts", async (e, arg) => {
    try {
      return await ttsWhole(arg || {});
    } catch (err) {
      return fail("error", String((err && err.message) || err));
    }
  });

  /* 画布节点 deepseek_tts 走这条：整段 / 流式都落成一份 wav，回绝对路径 */
  ipcMain.handle("dsSpeech:ttsFile", async (e, arg) => {
    try {
      return await ttsFile(arg || {});
    } catch (err) {
      return fail("error", String((err && err.message) || err));
    }
  });

  ipcMain.handle("dsSpeech:ttsStream", async (e, arg) => {
    const a = arg || {};
    const session = String(a.session || "");
    const sender = e.sender;
    let seq = 0;
    /* opt-in：边流式边落一份 wav（状态栏播报按钮要留一份可回放的音频；
       不传 saveWav 就完全不碰磁盘，行为与以前一样）。 */
    let saveFd = -1;
    let savePath = "";
    let saveBytes = 0;
    let saveErr = null;
    if (a.saveWav) {
      savePath = String(a.savePath || "").trim() || tmpOutPath(".wav");
      try {
        ensureDirFor(savePath);
        saveFd = fs.openSync(savePath, "w");
        fs.writeSync(saveFd, wavHeader(0, TTS_SAMPLE_RATE), 0, 44, 0);
      } catch (err) {
        saveFd = -1;
        saveErr = String((err && err.message) || err);
      }
    }
    try {
      const r = await ttsStream({
        provider: a.provider,
        text: a.text,
        voiceId: a.voiceId,
        format: a.format,
        filterMarkdown: a.filterMarkdown,
        timeoutMs: a.timeoutMs,
        onPcm: (buf) => {
          const st = streams.get(session);
          if (st && st.cancelled) return;
          seq++;
          if (saveFd >= 0 && !saveErr) {
            try {
              fs.writeSync(saveFd, buf, 0, buf.length, null);
              saveBytes += buf.length;
            } catch (err) {
              saveErr = String((err && err.message) || err);
            }
          }
          try {
            if (!sender.isDestroyed())
              sender.send("dsSpeech:ttsChunk", { session, seq, pcm: buf.toString("base64") });
          } catch {}
        },
      });
      const out = Object.assign({ session }, r);
      if (saveFd >= 0) {
        try {
          fs.writeSync(saveFd, wavHeader(saveBytes, TTS_SAMPLE_RATE), 0, 44, 0);
        } catch (err) {
          saveErr = String((err && err.message) || err);
        }
        if (saveErr) {
          out.warn = "写 wav 失败：" + saveErr;
        } else {
          out.path = savePath;
          out.bytes = saveBytes;
          out.durationSec = Math.round((saveBytes / 2 / TTS_SAMPLE_RATE) * 100) / 100;
        }
      }
      return out;
    } catch (err) {
      return Object.assign({ session }, fail("error", String((err && err.message) || err)));
    } finally {
      if (saveFd >= 0) {
        try {
          fs.closeSync(saveFd);
        } catch {}
      }
      streams.delete(session);
    }
  });

  ipcMain.handle("dsSpeech:ttsCancel", async (e, arg) => {
    const session = String((arg && arg.session) || "");
    const st = streams.get(session);
    if (st) st.cancelled = true;
    else streams.set(session, { cancelled: true });
    return { ok: true };
  });

  ipcMain.handle("dsSpeech:asr", async (e, arg) => {
    try {
      return await asrOnce(arg || {});
    } catch (err) {
      return fail("error", String((err && err.message) || err));
    }
  });

  /* 一次 TTS 整段合成直接落文件（节点用；按钮走上面那条流式） */
  if (typeof o.onReady === "function") {
    try {
      o.onReady();
    } catch {}
  }
}

module.exports = {
  registerDsSpeechIpc,
  ttsWhole,
  ttsStream,
  ttsStreamToFile,
  ttsFile,
  asrOnce,
  splitForTts,
  readWavPcm,
  wavHeader,
  normBase,
  mapHttpError,
  DEFAULT_BASE,
  TTS_SAMPLE_RATE,
  ASR_MAX_BYTES,
};

"use strict";
/* ============================================================================
 * 本地语音转写 · 主进程侧小内核（speech-store.js）
 * ----------------------------------------------------------------------------
 * 为什么存在：画布节点级转写（音频接进文字节点 → 自动转写成文字注入提示词）
 * 从「Qwen3-ASR 本地 HTTP 后端」改为「dsh 运行时的官方本地 SenseVoice」之后，
 * 后端那一整套（asr/main-asr.js：安装 / venv / 模型 / ffmpeg / 起停 / 互斥锁）
 * 整块不再需要，但**转写缓存这条需求要留着**：
 *   · 同一份音频重复运行不该反复识别（命中缓存即秒回）；
 *   · 用户在节点上改过的错字要留着（edited），一处编辑全画布生效。
 * 识别本身走 dsh 语音通道（renderer/app-speech.js → window.api.dshSpeech），
 * 本文件只管「按音频签名缓存文本」，并守住数据目录纪律。
 *
 * 键 = sha1(规范化路径 | size | mtime | 语言 | 模型版本指纹 | 切分口径指纹)
 *   —— 文件被重新生成（mtime/size 变）自然不沿用旧文本；
 *      换识别模型 / 换语言也不会把上一代的文本当命中；
 *      切分口径变了（SEG_TAG）或用户改了「断句停顿」阈值（pauseMs）同样不命中 ——
 *      按旧停顿切出来的整段文本与按新停顿逐句切出来的文本不是一回事。
 * 落点 = <数据目录>/speech/transcripts.json（原子写；**绝不写应用目录**，见 AGENTS.md）
 * 上限 = 4MB（超出时按 at 从旧到新淘汰到 3MB，避免无限长大）
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ipcMain } = require("electron");

const MAX_BYTES = 4 * 1024 * 1024;
const TRIM_TO_BYTES = 3 * 1024 * 1024;
/* 模型版本指纹：换识别引擎 / 换模型时手动 +1（进缓存键，旧缓存自然失效） */
const MODEL_TAG = "sensevoice-1";
/* 切分口径指纹：切分规则变了就手动 +1（进缓存键，旧口径的文本自然失效）。
   sentence-pause-1 = 「不再限制长度：按短停顿逐句切、每句一次识别、每句一行」
   —— 在这之前的 60 秒定长切片（旧口径）缓存一律不再命中。 */
const SEG_TAG = "sentence-pause-1";

let getDataDir = null;
/** 单进程内一次只跑一个扫描（多条路同时要 cache 读写时串行，避免互相覆盖） */
let chain = Promise.resolve();

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function speechRoot() {
  return mk(join(String(getDataDir ? getDataDir() || "" : "."), "speech"));
}
function cachePath() {
  return join(speechRoot(), "transcripts.json");
}
function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
/** 文件签名（不存在 = size -1 / mtime 0：写入时也会被下次读取判定为「文件没了」） */
function fileKey(p) {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return { size: -1, mtime: 0 };
  }
}
/** 切分口径指纹：规则版本 + 这一轮实际用的「断句停顿」阈值（ms）。
 *  用户改设置 = 换口径 → 缓存键跟着变，不会拿旧阈值的文本冒充新结果。 */
function segTag(pauseMs) {
  const v = Math.round(Number(pauseMs) || 0);
  return SEG_TAG + (v > 0 ? "@" + v : "");
}
function cacheKey(p, language, pauseMs) {
  const st = fileKey(p);
  const norm = String(p || "").replace(/\//g, "\\").toLowerCase();
  return crypto
    .createHash("sha1")
    .update(
      norm +
        "|" +
        st.size +
        "|" +
        st.mtime +
        "|" +
        String(language || "auto") +
        "|" +
        MODEL_TAG +
        "|" +
        segTag(pauseMs),
    )
    .digest("hex");
}
function loadCache() {
  const c = readJson(cachePath(), null);
  if (c && typeof c === "object" && c.entries && typeof c.entries === "object") return c;
  return { ver: 1, entries: {} };
}
function trimCache(c) {
  let body = JSON.stringify(c);
  if (body.length <= MAX_BYTES) return c;
  const list = Object.keys(c.entries).map((k) => ({ k: k, at: Number(c.entries[k].at) || 0 }));
  list.sort((a, b) => a.at - b.at); /* 旧的先丢 */
  for (const it of list) {
    if (body.length <= TRIM_TO_BYTES) break;
    delete c.entries[it.k];
    body = JSON.stringify(c);
  }
  return c;
}
function saveCache(c) {
  writeJson(cachePath(), trimCache(c));
}

/* ---- 对外（IPC）：一条音频 → 已缓存的文本 ---- */
function cacheGet(opts) {
  opts = opts || {};
  const p = String(opts.path || "").trim();
  if (!p) return { ok: false, error: "no_path" };
  const c = loadCache();
  const hit = c.entries[cacheKey(p, opts.language, opts.pauseMs)];
  if (!hit || hit.text == null) return { ok: false, error: "miss" };
  return {
    ok: true,
    text: String(hit.text),
    edited: !!hit.edited,
    segments: Number(hit.segments) || 0,
    duration_sec: Number(hit.duration_sec) || 0,
    at: Number(hit.at) || 0,
  };
}
/* 写入：只有显式 edited=true 才覆盖用户改过的文本（自动转写不覆盖人工修订） */
function cacheSet(opts) {
  opts = opts || {};
  const p = String(opts.path || "").trim();
  if (!p) return { ok: false, error: "no_path" };
  const c = loadCache();
  const key = cacheKey(p, opts.language, opts.pauseMs);
  const prev = c.entries[key] || {};
  if (prev.edited && opts.edited !== true) return { ok: true, skipped: "edited" };
  const st = fileKey(p);
  c.entries[key] = {
    path: p,
    text: String(opts.text == null ? "" : opts.text),
    language: String(opts.language || "auto"),
    edited: opts.edited === true,
    segments: Number(opts.segments) || 0,
    duration_sec: Number(opts.duration_sec) || 0,
    size: st.size,
    mtime: st.mtime,
    at: Date.now(),
  };
  saveCache(c);
  return { ok: true, key: key };
}
function cacheClear(opts) {
  opts = opts || {};
  const c = loadCache();
  const p = String(opts.path || "").trim();
  if (!p) {
    const n = Object.keys(c.entries).length;
    c.entries = {};
    saveCache(c);
    return { ok: true, cleared: n };
  }
  /* 同一音频可能有多份（换语言 / 换模型留下的），全部清掉才是「重新转写」的语义 */
  const low = p.replace(/\//g, "\\").toLowerCase();
  let n = 0;
  for (const k of Object.keys(c.entries)) {
    const e = c.entries[k] || {};
    if (String(e.path || "").replace(/\//g, "\\").toLowerCase() === low) {
      delete c.entries[k];
      n++;
    }
  }
  saveCache(c);
  return { ok: true, cleared: n };
}
/** 只读概况（设置 / 诊断用；列表按最近使用倒序，最多 200 条） */
function cacheList() {
  const c = loadCache();
  const all = Object.keys(c.entries).map((k) => Object.assign({ key: k }, c.entries[k]));
  all.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return { ok: true, count: all.length, entries: all.slice(0, 200) };
}
/** 读任意本机音频的原始字节（渲染层 decodeAudioData 用它；只读、不写） */
function readAudioBytes(p, maxBytes) {
  const src = String(p || "");
  if (!src) return { ok: false, error: "no_path" };
  let st;
  try {
    st = fs.statSync(src);
  } catch {
    return { ok: false, error: "missing" };
  }
  if (!st.isFile()) return { ok: false, error: "missing" };
  const cap = Math.max(1024 * 1024, Math.min(2 * 1024 * 1024 * 1024, Number(maxBytes) || 256 * 1024 * 1024));
  const sizeHuman =
    st.size >= 1024 * 1024
      ? (st.size / (1024 * 1024)).toFixed(1) + " MB"
      : Math.max(1, Math.round(st.size / 1024)) + " KB";
  if (st.size > cap) return { ok: true, tooBig: true, bytes: null, size: st.size, sizeHuman: sizeHuman };
  try {
    return {
      ok: true,
      bytes: fs.readFileSync(src),
      size: st.size,
      sizeHuman: sizeHuman,
      mtime: Math.floor(st.mtimeMs),
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** 一次扫描串行执行（写盘是整份替换，并发会互相覆盖） */
function serial(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

function registerSpeechIpc(opts) {
  opts = opts || {};
  getDataDir = typeof opts.getDataDir === "function" ? opts.getDataDir : () => ".";
  /* file:readAudioBytes：转写用的音频读盘（比波形预览的 64MB 上限宽，长录音也能整段解码）。
     只读用户本机文件，不写任何东西；超过上限只回体积，不把几百 MB 灌进渲染层。 */
  ipcMain.handle("file:readAudioBytes", (e, p, maxBytes) => readAudioBytes(p, maxBytes));
  ipcMain.handle("speechCache:get", (e, o) => serial(() => cacheGet(o || {})));
  ipcMain.handle("speechCache:set", (e, o) => serial(() => cacheSet(o || {})));
  ipcMain.handle("speechCache:clear", (e, o) => serial(() => cacheClear(o || {})));
  ipcMain.handle("speechCache:list", () => serial(() => cacheList()));
}

module.exports = {
  registerSpeechIpc,
  cacheGet: (...a) => serial(() => cacheGet(...a)),
  cacheSet: (...a) => serial(() => cacheSet(...a)),
  cacheClear: (...a) => serial(() => cacheClear(...a)),
  cacheList,
  readAudioBytes,
  MODEL_TAG,
  SEG_TAG,
};

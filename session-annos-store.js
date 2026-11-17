/* ============ 会话局部批注的独立存储（session-annos-store.js） ============

   为什么单独一份文件、而不是塞进会话正文（agent-sessions/ 那份 <id>.json）：
     · 会话正文走「基线 + 追加段」的增量落盘：一窗口里改的通常只有「新增的几条消息」，
       主进程 appendDelta 只追加 messages，**基线顶层字段一个字节都不动** ——
       批注这种「只改顶层字段、不动消息」的编辑，走 session:save 那条路根本落不了盘
       （要落得先整份重写几 MB 的会话，代价与收益完全不成比例）；
     · patchSessionMeta 那条通道是「按 id 重写整份会话文件」，也不适合高频编辑的批注。

   所以批注按会话 id 单独落一份小 JSON：<数据目录>/session-annos/<id>.json。
   数据不落应用目录（与 AGENTS.md 的「用户数据只写 %APPDATA% 或用户选定项目文件夹」一致），
   dataDir 由 main.js 现取（DATA()）。

   一条批注（渲染层语义写在 renderer/app-annotate.js 文件头，这里只做归一化与裁剪）：
     { id, msgKey, aiIdx, quote, occ, body, at, applied, used, usedAt }
     · msgKey = 消息行的稳定键（渲染层 dataset.histKey），锚点首选；
     · aiIdx  = 该消息在「AI 回复」里的序号（msgKey 对不上时的兜底）；
     · quote  = 被批注的原文（重锚靠它），occ = 同一条消息里第几次出现（默认 0）；
     · body   = 批注正文；applied = 已写进发送栏；used = 已经随某一轮发出去过。

   写盘是原子写（tmp + rename）：批注卡里逐字编辑会触发多次保存，
   半截文件比丢一次编辑更糟。 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

/* 会话 id 的形状：与 agent-sessions-store.js 的 ID_OK 同口径（渲染层只会传它自己那些 id） */
const ID_OK = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_ANNOS = 300;
const MAX_BODY = 8000;
const MAX_QUOTE = 8000;
const MAX_KEY = 200;
const ANNO_VER = 1;

function clampStr(v, max) {
  const s = String(v == null ? "" : v);
  return s.length > max ? s.slice(0, max) : s;
}

/* 一条批注的归一化：坏条目直接丢（返回 null），好条目把所有字段收成确定形状 */
function normalizeAnno(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rawId = clampStr(raw.id, 32);
  /* id 是批注的唯一身份（发送栏正文块里的 `#id` 就是它）：**只认已经合法的形状**，
     不做「把非法字符抹掉」那种改写 —— 改写等于换一个身份，块与卡片就对不上了。 */
  if (!/^[0-9a-z]{3,16}$/.test(rawId)) return null;
  const id = rawId;
  const body = clampStr(raw.body, MAX_BODY);
  const quote = clampStr(raw.quote, MAX_QUOTE);
  if (!body && !quote) return null;
  const at = Number(raw.at) || 0;
  return {
    id: id,
    msgKey: clampStr(raw.msgKey, MAX_KEY),
    aiIdx: Number.isFinite(Number(raw.aiIdx)) ? Math.max(0, Math.trunc(Number(raw.aiIdx))) : -1,
    quote: quote,
    occ: Math.max(0, Math.trunc(Number(raw.occ) || 0)),
    body: body,
    /* scope = text（拖选的一段文字）/ block（整块吸附：表格 / 代码块 / 引用 / 图片）；
       blockIdx = 那一块在该条消息里的序号（整块批注的锚点，文本锚点对它没用） */
    scope: raw.scope === "block" ? "block" : "text",
    blockIdx: Number.isFinite(Number(raw.blockIdx))
      ? Math.max(0, Math.trunc(Number(raw.blockIdx)))
      : -1,
    at: at > 0 ? at : Date.now(),
    applied: !!raw.applied,
    used: !!raw.used,
    usedAt: Number(raw.usedAt) || 0,
  };
}

function createSessionAnnosStore(opts) {
  const o = opts || {};
  const dataDir = typeof o.dataDir === "function" ? o.dataDir : () => String(o.dataDir || "");
  const log = typeof o.log === "function" ? o.log : () => {};

  function dir() {
    return path.join(String(dataDir() || ""), "session-annos");
  }
  function fileOf(id) {
    return path.join(dir(), String(id) + ".json");
  }
  function mkdirAll(p) {
    try {
      fs.mkdirSync(p, { recursive: true });
      return true;
    } catch (e) {
      log("[annos] 建目录失败 " + p + "：" + String((e && e.message) || e));
      return false;
    }
  }
  /* 原子写：先写 .tmp 再 rename（同目录 rename 是原子的） */
  async function writeAtomic(file, text) {
    const tmp = file + "." + process.pid + "." + Date.now().toString(36) + ".tmp";
    await fsp.writeFile(tmp, text, "utf8");
    try {
      await fsp.rename(tmp, file);
    } catch (e) {
      try {
        await fsp.unlink(file);
      } catch {}
      await fsp.rename(tmp, file);
    }
  }

  /* 读一条会话的全部批注：文件不在 = 空表（不是错误 —— 绝大多数会话一条批注都没有） */
  function load(id) {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return { ok: false, error: "bad_id", annos: [] };
    let text = "";
    try {
      text = fs.readFileSync(fileOf(sid), "utf8");
    } catch {
      return { ok: true, id: sid, annos: [], empty: true };
    }
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, error: "bad_json", id: sid, annos: [] };
    }
    const list = obj && Array.isArray(obj.annos) ? obj.annos : [];
    const annos = [];
    for (const it of list) {
      const n = normalizeAnno(it);
      if (n) annos.push(n);
    }
    return { ok: true, id: sid, annos: annos, updatedAt: Number(obj && obj.updatedAt) || 0 };
  }

  /* 存一条会话的全部批注（整表覆盖：渲染层手上那一份就是真源）。
     空表 = 删文件（不留一堆 {} 垃圾）。 */
  async function save(id, annos) {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return { ok: false, error: "bad_id" };
    const raw = Array.isArray(annos) ? annos : [];
    const out = [];
    const seen = new Set();
    for (const it of raw) {
      const n = normalizeAnno(it);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      if (out.length >= MAX_ANNOS) break;
    }
    if (!out.length) {
      try {
        await fsp.unlink(fileOf(sid));
      } catch {}
      return { ok: true, id: sid, count: 0, removed: true };
    }
    if (!mkdirAll(dir())) return { ok: false, error: "mkdir" };
    const payload = { ver: ANNO_VER, id: sid, updatedAt: Date.now(), annos: out };
    const text = JSON.stringify(payload);
    try {
      await writeAtomic(fileOf(sid), text);
    } catch (e) {
      log("[annos] 写 " + sid + " 失败：" + String((e && e.message) || e));
      return { ok: false, error: "write" };
    }
    return { ok: true, id: sid, count: out.length, bytes: Buffer.byteLength(text) };
  }

  /* 会话被删掉时顺手回收它的批注文件（渲染层删除会话那条路会点名） */
  async function remove(id) {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return { ok: false, error: "bad_id" };
    let removed = false;
    try {
      await fsp.unlink(fileOf(sid));
      removed = true;
    } catch {}
    return { ok: true, id: sid, removed: removed };
  }

  return { dir, fileOf, load, save, remove };
}

module.exports = { createSessionAnnosStore, normalizeAnno };

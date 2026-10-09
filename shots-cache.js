"use strict";
/* 上架截图的**本机缓存**（本轮需求：开发者截图上传后本地保存，下次更新自动带上）
 *
 * 为什么需要它：上架窗原来只在本机留「云端已有这张图」的指纹索引（store-imgfp.json，
 * 只有 sha、没有字节）。于是云端对象一旦被别人清掉（服务端回 OBJ_NOT_FOUND），本机根本
 * 重传不了、只能报错；而作者每次更新都得重新拍 / 重新选图。
 *
 * 口径（与用户确认过）：
 *   · 存**压缩后那一份**（长边 2560 / 单张 ≤5MB，即真正传上云的那批字节）——
 *     与服务端落盘字节完全一致，所以重传时 sha 一致、直接命中云端对象库，不重复占空间；
 *   · **按内容寻址**：文件名就是 sha256（`<数据目录>/shots-cache/<sha>.<ext>`），
 *     同一张图在多个应用之间只存一份；
 *   · 索引 `<数据目录>/store-shots.json` 记「哪些 sha 有本地字节 + 归属哪些应用」，
 *     删除应用时按应用引用回收（被别的应用共用的那些留着 —— 与云端对象库同一口径）；
 *   · 只有作者自己上传过的图会进来（上传成功后由渲染层把这一批交上来），不主动抓任何东西；
 *   · 本机数据一律落 <数据目录>（%APPDATA%），**绝不落应用文件夹**（AGENTS.md 的硬约定）。
 *
 * 为什么独立成模块（而不是写在 main.js 里）：这套「内容寻址 + 引用回收 + 淘汰」是本需求的
 * 核心行为，抽出来才能在 test/smoke-app-shots-cache.js 里**真跑**（构造两个应用共用一张图、
 * 删一个留一个、清空、淘汰），不必为它起 Electron。main.js 只负责把三个动作挂到 IPC 上。
 */

const fs = require("fs");
const path = require("path");

const SHA_RE = /^[0-9a-f]{64}$/;
const IMG_EXTS = ["png", "jpg", "jpeg", "webp"];
/* 本机缓存的总量闸门：超了按 lastUsedAt 从旧到新淘汰（缓存只是便利，丢几张不影响功能） */
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ITEMS = 200;
const INDEX_FILE = "store-shots.json";

/** 一张图的落盘文件名：`<sha>.<ext>`（ext 只认图片那三种；认不出一律 png）。 */
function fileNameOf(sha, ext) {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  const safe = IMG_EXTS.indexOf(e) >= 0 ? e : "png";
  return String(sha) + "." + safe;
}

/** data URL → {buf, ext}；不是图片 data URL / 空内容时回 null。 */
function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || "");
  if (!s) return null;
  const at = s.indexOf(",");
  if (at < 0) return null;
  const head = s.slice(0, at);
  const m = /^data:image\/([a-z0-9.+-]+)/i.exec(head);
  if (!m) return null;
  const buf = Buffer.from(s.slice(at + 1).replace(/\s+/g, ""), "base64");
  if (!buf.length) return null;
  return { buf: buf, ext: m[1].toLowerCase() };
}

function mimeOf(file) {
  if (/\.jpe?g$/i.test(file)) return "image/jpeg";
  if (/\.webp$/i.test(file)) return "image/webp";
  return "image/png";
}

/**
 * 建一个以 dataDir 为根的截图缓存实例。
 * 入参 dataDir 由调用方给（main.js 给 DATA()，冒烟给临时目录）—— 本模块自己不猜路径。
 * 返回 { put, list, clear, describe }，全部同步、全部 fail-soft（读不出索引就当空，
 * 单个文件删不掉不抛），因为这只是「便利」，绝不能挡住上架主流程。
 */
function createShotsCache(opts) {
  const o = opts || {};
  const root = String(o.dataDir || "");
  const maxBytes = Math.max(1024 * 1024, Number(o.maxBytes) || MAX_BYTES);
  const maxItems = Math.max(1, Number(o.maxItems) || MAX_ITEMS);
  const dirOf = () => path.join(root, "shots-cache");
  const indexPath = () => path.join(root, INDEX_FILE);
  let cache = null;

  function read() {
    if (cache) return cache;
    let items = {};
    try {
      const cur = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
      if (cur && typeof cur.items === "object" && cur.items) items = cur.items;
    } catch (_) {}
    cache = { ver: 1, items: items };
    return cache;
  }

  function write() {
    const db = read();
    const keys = Object.keys(db.items);
    let total = 0;
    for (const k of keys) total += Number((db.items[k] && db.items[k].bytes) || 0);
    if (total > maxBytes || keys.length > maxItems) {
      const byAge = keys
        .slice()
        .sort((a, b) => Number(db.items[a].lastUsedAt || 0) - Number(db.items[b].lastUsedAt || 0));
      for (const k of byAge) {
        if (total <= maxBytes && Object.keys(db.items).length <= maxItems) break;
        const e = db.items[k];
        try {
          if (e && e.file) fs.unlinkSync(path.join(dirOf(), e.file));
        } catch (_) {}
        total -= Number((e && e.bytes) || 0);
        delete db.items[k];
      }
    }
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(indexPath(), JSON.stringify(db) + "\n");
    } catch (_) {}
  }

  /** 各条缓存占用的总字节（按索引里的 bytes 求和）。 */
  function totalBytes() {
    const db = read();
    let n = 0;
    for (const k of Object.keys(db.items)) n += Number(db.items[k].bytes || 0);
    return n;
  }

  return {
    dir: dirOf,
    indexPath: indexPath,
    /** 上传成功后把这一批存下来。items: [{sha, dataUrl?, ext?, bytes?}]；appId 记归属。 */
    put(appId, items) {
      const db = read();
      const id = String(appId || "");
      let saved = 0;
      let skipped = 0;
      for (const it of Array.isArray(items) ? items : []) {
        const sha = String((it && it.sha) || "").trim().toLowerCase();
        if (!SHA_RE.test(sha)) {
          skipped++;
          continue;
        }
        const prev = db.items[sha];
        const apps = new Set(Array.isArray(prev && prev.apps) ? prev.apps : []);
        if (id) apps.add(id);
        const dec = decodeDataUrl(it && it.dataUrl);
        if (!dec && !prev) {
          skipped++; /* 没有字节、本机也没有这一份 → 不写索引（免得记一条指向不存在文件的条目） */
          continue;
        }
        const file = fileNameOf(sha, (dec && dec.ext) || (it && it.ext) || (prev && prev.ext));
        const abs = path.join(dirOf(), file);
        let bytes = Number((prev && prev.bytes) || 0);
        if (dec) {
          try {
            fs.mkdirSync(dirOf(), { recursive: true });
            /* 内容寻址：同名文件已经在盘上、大小一致就不重写（同图重复上传一个字节都不动） */
            let same = false;
            try {
              same = fs.statSync(abs).size === dec.buf.length;
            } catch (_) {}
            if (!same) fs.writeFileSync(abs, dec.buf);
            bytes = dec.buf.length;
            saved++;
          } catch (_) {
            skipped++;
            continue;
          }
        }
        db.items[sha] = {
          file: file,
          bytes: bytes,
          ext: file.split(".").pop(),
          apps: Array.from(apps).slice(0, 50),
          at: Number((prev && prev.at) || 0) || Date.now(),
          lastUsedAt: Date.now(),
        };
      }
      write();
      return { ok: true, saved: saved, skipped: skipped, total: Object.keys(read().items).length, bytes: totalBytes() };
    },
    /** 列清单。withData:true 时把文件读成 dataUrl（上架窗要拿它当提交字节）。 */
    list(withData) {
      const db = read();
      const items = [];
      for (const sha of Object.keys(db.items)) {
        const it = db.items[sha] || {};
        const abs = path.join(dirOf(), String(it.file || ""));
        let stat = null;
        try {
          stat = fs.statSync(abs);
        } catch (_) {}
        if (!stat || !stat.isFile()) continue; /* 文件被外力删了：这一条视为不存在 */
        const row = {
          sha: sha,
          bytes: stat.size,
          ext: it.ext || "",
          apps: Array.isArray(it.apps) ? it.apps : [],
        };
        if (withData) {
          try {
            row.dataUrl = "data:" + mimeOf(abs) + ";base64," + fs.readFileSync(abs).toString("base64");
          } catch (_) {
            continue;
          }
        }
        items.push(row);
      }
      let total = 0;
      for (const r of items) total += Number(r.bytes) || 0;
      return { ok: true, items: items, total: items.length, bytes: total };
    },
    /** 回收：appId 给定时只删「只属于它」的图（共用的留着）；appId 省略 = 清空全部。 */
    clear(appId) {
      const db = read();
      const id = String(appId || "");
      let removed = 0;
      let freedBytes = 0;
      for (const sha of Object.keys(db.items)) {
        const it = db.items[sha] || {};
        const apps = Array.isArray(it.apps) ? it.apps : [];
        let kill = false;
        if (!id) kill = true;
        else if (apps.indexOf(id) >= 0) kill = apps.filter((x) => x !== id).length === 0;
        if (!kill) {
          if (id) db.items[sha].apps = apps.filter((x) => x !== id);
          continue;
        }
        try {
          fs.unlinkSync(path.join(dirOf(), String(it.file || "")));
        } catch (_) {}
        freedBytes += Number(it.bytes) || 0;
        delete db.items[sha];
        removed++;
      }
      write();
      return { ok: true, removed: removed, freedBytes: freedBytes, total: Object.keys(read().items).length };
    },
    describe() {
      const db = read();
      return { dir: dirOf(), indexPath: indexPath(), items: Object.keys(db.items).length, bytes: totalBytes() };
    },
  };
}

module.exports = { createShotsCache, fileNameOf, decodeDataUrl, MAX_BYTES, MAX_ITEMS, INDEX_FILE };

"use strict";
/* 应用中心封面懒加载的**真浏览器验证服务**（人工跑）：
     node test/_verify-apps-img.cjs        # 起服务，浏览器打开 http://127.0.0.1:8798/_preview-apps-img.html
   它只做两件事：
     1) 按仓库路径发真文件（renderer/app-apps-img.js / renderer/css/apps.css）—— 验证台里
        跑的就是应用里的那一份，不是抄件；
     2) /img?d=<ms>&i=<n> 故意慢 d 毫秒再回一张真 PNG（1×1 也行，卡片是背景图 cover）：
        模拟「图一张张到」的网络，用来验「同一批一起显形」。
   页面把量到的结论挂在 window.__APPS_IMG_RESULT（第一行状态条也直接显示）。 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8798);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
/* 一张真 PNG：16×9 亮橙色（够 cover 铺满卡片，且和深色底一眼看得出差别 ——
   透明/纯黑的小图在深色主题下肉眼看不出「到底显形没有」，截图与肉眼核对都会被误导） */
const PNG = (() => {
  const w = 16;
  const h = 9;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0; /* filter: none */
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 4;
      raw[o] = 0xff; /* R */
      raw[o + 1] = 0x8f; /* G */
      raw[o + 2] = 0x2e; /* B */
      raw[o + 3] = 0xff; /* A */
    }
  }
  const zlib = require("zlib");
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; /* bit depth */
  ihdr[9] = 6; /* RGBA */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

http
  .createServer((req, res) => {
    const u = decodeURIComponent(String(req.url || "/"));
    const q = new URL(u, "http://127.0.0.1:" + PORT).searchParams;
    if (u.split("?")[0] === "/img") {
      const d = Math.max(0, Math.min(5000, Number(q.get("d") || 0)));
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(PNG);
      }, d);
      return;
    }
    const raw = u.split("?")[0];
    /* 目录式入口：/ 与 /_preview-apps-img.html 都发验证台那一份 */
    const rel = raw === "/" || raw === "/_preview-apps-img.html" ? "/test/_preview-apps-img.html" : raw;
    /* path.join(ROOT, "/x") 在 Windows 上会变成「盘根 + \x」而不是 ROOT\x —— 先去掉前导斜杠 */
    const p = path.join(ROOT, rel.replace(/^[/\\]+/, ""));
    if (!p.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(p, (e, b) => {
      if (e) {
        res.writeHead(404).end("404 " + rel);
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream",
        /* 验证台要的**永远是盘上这一份**：禁用缓存，否则改完模块浏览器还跑旧的（实测踩过） */
        "Cache-Control": "no-store",
      });
      res.end(b);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log("apps-img verify server on http://127.0.0.1:" + PORT + "/_preview-apps-img.html"));

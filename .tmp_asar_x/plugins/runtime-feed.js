"use strict";
/**
 * 插件脚手架云端包下载（Music3 / H3 等）：manifest + zip → 解压到 destDir。
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function rmDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || []);
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d, skip);
    else {
      mk(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}

function verParts(v) {
  return String(v || "0")
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((x) => {
      const n = parseInt(x, 10);
      return Number.isFinite(n) ? n : 0;
    });
}
function verCmp(a, b) {
  const aa = verParts(a);
  const bb = verParts(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] || 0;
    const y = bb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
function verGt(a, b) {
  return verCmp(a, b) > 0;
}
function verMax(a, b) {
  return verCmp(a, b) >= 0 ? String(a || "") : String(b || "");
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fetchBuffer(url, onProgress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: { "User-Agent": "MTNodeAIO/plugin-runtime" },
        timeout: timeoutMs || 180000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchBuffer(res.headers.location, onProgress, timeoutMs).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        const total = Number(res.headers["content-length"]) || 0;
        const chunks = [];
        let got = 0;
        res.on("data", (c) => {
          chunks.push(c);
          got += c.length;
          if (onProgress) onProgress({ got, total });
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function unzipBuffer(buf, destDir) {
  mk(destDir);
  let o = 0;
  while (o + 4 <= buf.length) {
    const sig = buf.readUInt32LE(o);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(o + 8);
    const compSize = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nameLen).toString("utf8");
    const dataStart = o + 30 + nameLen + extraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    o = dataStart + compSize;
    if (!name || /(?:^|\/|\\)\.\.(?:\/|\\|$)/.test(name)) continue;
    const outPath = join(destDir, ...name.split(/[/\\]/).filter(Boolean));
    if (name.endsWith("/") || name.endsWith("\\")) {
      mk(outPath);
      continue;
    }
    mk(path.dirname(outPath));
    let raw;
    if (method === 0) raw = compressed;
    else if (method === 8) raw = zlib.inflateRawSync(compressed);
    else throw new Error("unsupported zip method " + method);
    fs.writeFileSync(outPath, raw);
  }
}

function resolveZipUrl(feedBase, zipUrl) {
  let u = String(zipUrl || "").trim();
  if (!u) return "";
  const base = String(feedBase || "").replace(/\/$/, "");
  if (u.startsWith("/")) return base + u;
  if (!/^https?:\/\//i.test(u)) return base + "/" + u.replace(/^\.\//, "");
  return u;
}

/**
 * @param {{ feedBase: string, destDir: string, onProgress?: Function, userAgent?: string }} opts
 */
async function downloadRuntimeTo(opts) {
  const feedBase = String(opts.feedBase || "").replace(/\/$/, "");
  const destDir = opts.destDir;
  if (!feedBase) throw new Error("no_feed");
  if (!destDir) throw new Error("no_dest");
  const onProgress = opts.onProgress || (() => {});

  onProgress({ phase: "manifest", pct: 2 });
  const manBuf = await fetchBuffer(feedBase + "/manifest.json", null, 15000);
  const man = JSON.parse(manBuf.toString("utf8"));
  if (!man || !man.zipUrl) throw new Error("bad_manifest");
  const zipUrl = resolveZipUrl(feedBase, man.zipUrl);
  if (!zipUrl) throw new Error("bad_zip_url");

  onProgress({ phase: "download", pct: 5, version: man.version });
  const zipBuf = await fetchBuffer(zipUrl, ({ got, total }) => {
    const pct = total ? Math.min(90, 5 + Math.floor((got / total) * 85)) : 40;
    onProgress({ phase: "download", pct, got, total, version: man.version });
  });
  if (man.sha256) {
    const h = sha256(zipBuf);
    if (h.toLowerCase() !== String(man.sha256).toLowerCase()) {
      throw new Error("sha256_mismatch");
    }
  }

  onProgress({ phase: "extract", pct: 92 });
  const tmp = destDir + "_extract_tmp";
  rmDirRecursive(tmp);
  mk(tmp);
  unzipBuffer(zipBuf, tmp);
  let srcDir = tmp;
  const ents = fs.readdirSync(tmp);
  if (ents.length === 1) {
    const only = join(tmp, ents[0]);
    if (fs.statSync(only).isDirectory() && fs.existsSync(join(only, "manifest.json"))) {
      srcDir = only;
    }
  }
  if (!fs.existsSync(join(srcDir, "manifest.json"))) {
    rmDirRecursive(tmp);
    throw new Error("pack_missing_manifest");
  }
  rmDirRecursive(destDir);
  copyDirRecursive(srcDir, destDir, []);
  rmDirRecursive(tmp);
  onProgress({ phase: "done", pct: 100, version: man.version });
  return { ok: true, version: String(man.version || ""), manifest: man, source: zipUrl };
}

async function fetchRemoteManifest(feedBase, timeoutMs) {
  const base = String(feedBase || "").replace(/\/$/, "");
  if (!base) return null;
  try {
    const buf = await fetchBuffer(base + "/manifest.json", null, timeoutMs || 8000);
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  verCmp,
  verGt,
  verMax,
  fetchBuffer,
  fetchRemoteManifest,
  downloadRuntimeTo,
  copyDirRecursive,
  rmDirRecursive,
  mk,
  join,
};

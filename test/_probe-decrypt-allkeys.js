/* 只读探针（非交付件）：用 test/_probe-keys.json 里的所有候选主密钥逐个试解 auth-store.json。
   只打印成功者与账号名，不打印明文 token。用法：node test/_probe-decrypt-allkeys.js */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const keys = JSON.parse(fs.readFileSync(path.join(__dirname, "_probe-keys.json"), "utf8").replace(/^\uFEFF/, ""));
const store = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "pipeline-console", "auth-store.json"), "utf8"));
const b = Buffer.from(store.payload, "base64");

const layouts = [
  { n: "v10|nonce12|ct|tag末", nonce: [3, 15], ct: [15, b.length - 16], tag: [b.length - 16, null] },
  { n: "v10|nonce12|tag|ct", nonce: [3, 15], ct: [31, null], tag: [15, 31] },
  { n: "无前缀|nonce12|ct|tag末", nonce: [0, 12], ct: [12, b.length - 16], tag: [b.length - 16, null] },
];
const sub = (buf, r) => (r[1] === null ? buf.subarray(r[0]) : buf.subarray(r[0], r[1]));

let hit = null;
for (const k of keys) {
  if (!k.key) continue;
  const raw = Buffer.from(k.key, "base64");
  const variants = { raw, sha256: crypto.createHash("sha256").update(raw).digest() };
  for (const [vn, key] of Object.entries(variants)) {
    for (const L of layouts) {
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", key, sub(b, L.nonce));
        d.setAuthTag(sub(b, L.tag));
        const p = Buffer.concat([d.update(sub(b, L.ct)), d.final()]).toString("utf8");
        const o = JSON.parse(p);
        console.log("✅ 成功：key 来自 " + k.file + "（" + vn + " / " + L.n + "）| 账号=" + (o.user && o.user.username) + " | tokenLen=" + String(o.token || "").length);
        hit = { file: k.file, variant: vn, layout: L.n, token: String(o.token || ""), user: o.user };
      } catch {}
    }
  }
}
if (hit) {
  fs.writeFileSync(path.join(__dirname, "_probe-token.json"), JSON.stringify({ file: hit.file, variant: hit.variant, layout: hit.layout, token: hit.token, user: hit.user }, null, 2));
  console.log("（token 已写入 test/_probe-token.json 供本轮实测，收尾会删）");
} else {
  console.log("❌ 所有候选密钥 × 布局都失败");
}

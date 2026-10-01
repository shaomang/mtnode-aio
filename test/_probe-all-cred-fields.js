/* 只读探针（非交付件）：把 config.json 里所有可能承载凭据的字段全扫一遍（含节点级 / dsh 段），
   只打印打码串与出现位置，明文不出终端。
   用法：node test/_probe-all-cred-fields.js */
const fs = require("fs");
const path = require("path");
const P = path.join(process.env.APPDATA, "pipeline-console", "pipeline-console", "config.json");
const txt = fs.readFileSync(P, "utf8");
const j = JSON.parse(txt);

const mask = (s) => {
  s = String(s == null ? "" : s);
  if (!s) return "(空)";
  return s.length <= 7 ? "*".repeat(s.length) + "[len" + s.length + "]" : s.slice(0, 4) + "****" + s.slice(-4) + "[len" + s.length + "]";
};

const seen = new Map();
const walk = (o, p) => {
  if (!o || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    const np = p + "." + k;
    if (/^(apiKey|apikey|api_key|key|token|secret|authKey|keyMasked|apiKeyEnv)$/i.test(k) && typeof v === "string") {
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(np + " = " + mask(v));
    }
    if (v && typeof v === "object") walk(v, np);
  }
};
walk(j, "$");
for (const [k, list] of seen) {
  console.log("\n### 字段名 " + k + "（" + list.length + " 处）");
  list.slice(0, 40).forEach((x) => console.log("  " + x));
}

console.log("\n=== 顶层键 ===");
console.log(Object.keys(j).join(", "));
console.log("\n=== providers 里的 relay 字段 ===");
for (const p of j.providers || []) {
  if (p.relay) console.log(p.id, JSON.stringify(p.relay).slice(0, 300));
}
console.log("\n=== dsh 段 ===");
console.log(JSON.stringify(j.dsh || {}, null, 1).slice(0, 1200));

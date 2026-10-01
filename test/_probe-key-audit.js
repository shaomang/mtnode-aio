/* 只读探针（非交付件）：列出本机 config.json 里所有服务商的凭据口径，
   只打印打码串与长度，绝不打印明文。用法：node test/_probe-key-audit.js */
const fs = require("fs");
const path = require("path");
const P = path.join(process.env.APPDATA, "pipeline-console", "pipeline-console", "config.json");
const mask = (s) => {
  s = String(s == null ? "" : s);
  if (!s) return "(空)";
  if (s.length <= 7) return "*".repeat(s.length) + " len=" + s.length;
  return s.slice(0, 4) + "****" + s.slice(-4) + " len=" + s.length;
};
const c = JSON.parse(fs.readFileSync(P, "utf8"));
console.log("config.json:", P, fs.statSync(P).size, "bytes");
console.log("defaultProvider:", JSON.stringify(c.defaultProvider || c.activeProvider || null));
const ps = c.providers || [];
console.log("providers 共", ps.length, "个");
for (const p of ps) {
  console.log("---");
  console.log(" id=", p.id, "| name=", p.name, "| source=", p.source, "| type=", p.type || p.kind);
  console.log(" baseUrl=", p.baseUrl, "| apiKey=", mask(p.apiKey));
  console.log(" models=", (p.models || []).length, (p.models || []).slice(0, 6).map((m) => (typeof m === "string" ? m : m && m.id)).join(","));
  if (p.relay) {
    const r = p.relay;
    console.log(" relay=", JSON.stringify({ baseUrl: r.baseUrl, apiKey: mask(r.apiKey), keyMasked: r.keyMasked, authKey: r.authKey, enabled: r.enabled, providerName: r.providerName, at: r.at, error: r.error }).slice(0, 400));
  }
  if (p.blocks) console.log(" blocks=", JSON.stringify(p.blocks).slice(0, 200));
}
/* 哪些服务商的 Key 是可疑的短串（如 123）——只报 id 与打码，不报明文 */
const susp = ps.filter((p) => {
  const k = String(p.apiKey || "").trim();
  return k && k.length <= 7;
}).map((p) => p.id + " → " + mask(p.apiKey));
console.log("可疑短 Key 服务商：", susp.length ? susp.join(" | ") : "无");

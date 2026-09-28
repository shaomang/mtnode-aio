/* audit-run.mjs — 正式跑的产物自查（只读，不改任何数据）
   1) 配对核对：每题两臂齐全、无缺无重、行 schema 字段齐（usage / metrics / tools / steps / interactions / finalResponse）
   2) 密钥脱敏自查：用本机 MTNode config.json 里的**真实密钥串**全文扫 results.jsonl / run-meta.json / runner.log，
      另加通用形态扫描（sk-…、Bearer …、api_key=…）。输出只有命中计数与密钥指纹前 8 位，**绝不打印密钥本身**。
   用法：node scripts/bench/audit-run.mjs <runName> <armA,armB> [--extra <file> ...] */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const run = process.argv[2] || "full2";
const arms = (process.argv[3] || "code,minimal").split(",").map((s) => s.trim()).filter(Boolean);
const runDir = path.join(process.env.LOCALAPPDATA, "mtnode-bench", "runs", run);
const files = [
  path.join(runDir, "results.jsonl"),
  path.join(runDir, "run-meta.json"),
  path.join(runDir, "runner.log"),
].filter((f) => fs.existsSync(f));

const fp = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
const out = [];
const P = (s) => { out.push(s); console.log(s); };

/* ---------------- 1) 配对核对 ---------------- */
const linesRaw = fs.readFileSync(path.join(runDir, "results.jsonl"), "utf8").split("\n").filter((l) => l.trim());
const rows = [];
let bad = 0;
linesRaw.forEach((l, i) => { try { rows.push(JSON.parse(l)); } catch { bad++; P(`! 第 ${i + 1} 行不是合法 JSON（写入被截断？）`); } });
const scored = rows.filter((r) => !r.warmup);
const warm = rows.filter((r) => r.warmup);
P(`# 行数：总 ${rows.length}（计分 ${scored.length} / 预热 ${warm.length}）  解析失败 ${bad}`);
P(`# 臂分布：${arms.map((a) => `${a}=${rows.filter((r) => r.arm === a).length}`).join("  ")}` +
  (rows.some((r) => !arms.includes(r.arm)) ? `  未知臂=${rows.filter((r) => !arms.includes(r.arm)).length}` : ""));

const need = ["arm", "dataset", "id", "status", "usage", "metrics", "streamed", "interactions", "finalResponse", "runnerWallMs", "effortEffective"];
const missingField = {};
for (const r of scored) for (const k of need) if (!(k in r)) missingField[k] = (missingField[k] || 0) + 1;
P(`# 字段齐全性（计分 ${scored.length} 行）：${Object.keys(missingField).length ? JSON.stringify(missingField) : "全部字段齐（usage/metrics/streamed/interactions/finalResponse/runnerWallMs/effortEffective）"}`);
const usageKeys = ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "calls"];
const uZero = {};
for (const k of usageKeys) { const n = scored.filter((r) => !Number(r.usage?.[k]) && Number(r.usage?.[k]) !== 0).length; if (n) uZero[k] = n; }
const uAllZero = usageKeys.filter((k) => scored.every((r) => !r.usage?.[k]));
P(`# usage 子字段缺失 ${JSON.stringify(uZero)} | 整列恒为 0 的字段 ${JSON.stringify(uAllZero)}`);
const mKeys = ["wallMs", "steps", "turns", "llmMs", "toolMs", "firstTokenAvgMs", "tokPerSec", "cacheHitPct", "contextWindow", "models"];
P(`# metrics 子字段缺失 ${JSON.stringify(mKeys.filter((k) => scored.every((r) => !(k in (r.metrics || {})))))}`);

const g = (r) => `${r.dataset}|${r.id}`;
/* 期望唯一题数：优先读 run-meta.problems（题数 = 各数据集样本之和），读不到再退回 2×样本的老口径 */
let expectedKeys = 0;
try {
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, "run-meta.json"), "utf8"));
  expectedKeys = Object.values(meta.problems || {}).reduce((a, n) => a + Number(n || 0), 0);
} catch { /* 无 meta 时用观察值，下面会标注 */ }
const byKey = new Map();
for (const r of scored) { if (!byKey.has(g(r))) byKey.set(g(r), new Map()); byKey.get(g(r)).set(r.arm, (byKey.get(r.arm) || 0) + 1); }
const incomplete = [...byKey.entries()].filter(([, m]) => m.size !== arms.length);
const dup = [...byKey.entries()].flatMap(([k, m]) => [...m.entries()].filter(([, c]) => c > 1).map(([a, c]) => `${k} ${a}×${c}`));
P(`# 配对：唯一题数 ${byKey.size}（应为 ${expectedKeys || "未知"}），${arms.length} 臂齐全 ${byKey.size - incomplete.length}/${byKey.size}`);
P(`  缺臂题数 ${incomplete.length}${incomplete.length ? "：" + incomplete.slice(0, 20).map(([k, m]) => `${k}[${[...m.keys()].join(",")}]`).join(" ") : ""}`);
P(`  同题同臂重复 ${dup.length ? dup.slice(0, 20).join(" ") : "0（重试行以 attempt>1 记为额外行，见下）"}`);
const attempts = scored.reduce((a, r) => { const k = r.attempt ?? 1; a[k] = (a[k] || 0) + 1; return a; }, {});
P(`  attempt 分布 ${JSON.stringify(attempts)}`);
const status = {};
for (const r of rows) status[r.status] = (status[r.status] || 0) + 1;
P(`  status 分布 ${JSON.stringify(status)}`);
const errs = rows.filter((r) => r.status !== "ok").map((r) => `${r.arm} ${r.dataset}|${r.id} ${r.status} ${(r.error || "").slice(0, 90)}`);
if (errs.length) P("  非 ok 明细:\n    " + errs.slice(0, 40).join("\n    "));
const effByArm = {};
for (const a of arms) effByArm[a] = [...new Set(rows.filter((r) => r.arm === a).map((r) => `req:${r.effort ?? "?"}->eff:${r.effortEffective ?? "?"}`))];
P(`# 思考档（runner 记录）${JSON.stringify(effByArm)}`);
const ixSum = arms.map((a) => [a, rows.filter((r) => r.arm === a).reduce((s, r) => { for (const k in (r.interactions || {})) s[k] = (s[k] || 0) + r.interactions[k]; return s; }, {})]);
P(`# 交互计数 ${JSON.stringify(Object.fromEntries(ixSum))}`);
const toolSum = arms.map((a) => [a, rows.filter((r) => r.arm === a).reduce((s, r) => s + (r.streamed?.toolCalls || 0), 0)]);
P(`# 工具调用计数 ${JSON.stringify(Object.fromEntries(toolSum))}`);
P(`# finalResponse 非空率 ${arms.map((a) => { const rs = scored.filter((r) => r.arm === a); return `${a}=${rs.filter((r) => String(r.finalResponse || "").trim()).length}/${rs.length}`; }).join("  ")}`);

/* ---------------- 2) 密钥脱敏自查 ---------------- */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const secrets = new Set();
const add = (v) => { const s = String(v || ""); if (s.length >= 12) secrets.add(s); };
const dataDirCands = [
  path.join(process.env.APPDATA || "", "pipeline-console", "pipeline-console"),
  path.join(process.env.APPDATA || "", "pipeline-console"),
];
const dataDir = dataDirCands.find((c) => fs.existsSync(path.join(c, "config.json"))) || "";
/* 权威口径：直接用 runner 取凭据的同一模块，保证扫的就是本次真正下发给服务商的那串 Key */
try {
  const auth = createRequire(import.meta.url)(path.join(REPO_ROOT, "dsh", "mtnode-llm-creds.js")).resolveDshRunAuth(dataDir);
  if (auth && auth.ok) {
    add(auth.apiKey); add(auth.webSearchApiKey);
    for (const p of (auth.mtnodeProviders || [])) add(p.apiKey);
    P(`# 凭据来源：dsh/mtnode-llm-creds.js resolveDshRunAuth（对话 Key + 联网搜索 Key + ${auth.mtnodeProviders?.length || 0} 个 mtnode 服务商 Key）`);
  } else P(`# ! resolveDshRunAuth 未 ok：${auth && auth.error}`);
} catch (e) { P(`# ! 载入凭据模块失败：${e.message}`); }
/* 兜底：直接扫 config.json 里所有 apiKey / token 字段 */
for (const c of dataDirCands) {
  if (!fs.existsSync(path.join(c, "config.json"))) continue;
  const j = JSON.parse(fs.readFileSync(path.join(c, "config.json"), "utf8"));
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && /(^api[_-]?key$)|(^access[_-]?key$)|secret|token/i.test(k) && v.length >= 16) add(v);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(j);
}
/* 网关评测专用 settings.yaml 里被写入的服务商 key */
const settingsYaml = path.join(process.env.LOCALAPPDATA, "mtnode-bench", "gateway-home", "settings.yaml");
if (fs.existsSync(settingsYaml)) {
  for (const m of fs.readFileSync(settingsYaml, "utf8").matchAll(/^\s*(?:api[_-]?key|apiKey)\s*:\s*['"]?([^\s'"]{12,})/gim)) add(m[1]);
}
P(`\n# 密钥脱敏自查：本机真实密钥串 ${secrets.size} 个（只列长度与指纹，绝不打印明文）`);
let leak = 0;
for (const s of secrets) P(`  secret len=${s.length} sha256[:8]=${fp(s)}`);
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const hits = [...secrets].filter((s) => text.includes(s));
  leak += hits.length;
  P(`  ${path.basename(file).padEnd(16)} ${String(hits.length).padStart(2)} 命中${hits.length ? " 泄漏！指纹=" + hits.map(fp).join(",") : ""}  |  redactor 标记 «redacted-key» 出现 ${text.split("«redacted-key»").length - 1} 次`);
}
const pats = { "sk-[A-Za-z0-9]{16,}": /sk-[A-Za-z0-9]{16,}/g, "Bearer\\s+[A-Za-z0-9._-]{20,}": /Bearer\s+[A-Za-z0-9._-]{20,}/g, "api[_-]?key\\s*[:=]": /api[_-]?key\s*[:=]\s*['"]?[^\s'",}]{8,}/gi };
P("  通用形态扫描（可疑明文密钥样式，独立于本机密钥）：");
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const r = Object.entries(pats).map(([k, re]) => `${k}=${(text.match(re) || []).length}`);
  P(`    ${path.basename(file).padEnd(16)} ${r.join("  ")}`);
}
/* 前缀暴露扫描：runner 的 redactor 只替换**完整**密钥串；网关 runKey 里带的是 searchKey.slice(0,8)
   （dsh/gateway/gateway.mjs:886 `'|ws:' + searchKey.slice(0, 8)`）→ 必须按前缀单独查一遍。 */
P("  前缀暴露扫描（runKey 的 `ws:` 段会带搜索密钥前 8 位；完整串命中才算泄漏，前缀按风险分级）：");
const secretList = [...secrets];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const row = [];
  for (const L of [8, 12, 16, 20]) {
    const n = secretList.filter((s) => s.length > L && text.includes(s.slice(0, L))).length;
    if (n) row.push(`前${L}位命中 ${n}/${secretList.length}`);
  }
  P(`    ${path.basename(file).padEnd(16)} ${row.length ? row.join("  ") : "无任何 ≥8 位前缀命中"}`);
}
const longTok = {};
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  /* 20+ 位的高熵串（字母数字/-_），人工核对是否为凭据 */
  const toks = [...new Set((text.match(/[A-Za-z0-9_\-.]{24,}/g) || []).filter((t) => /[A-Za-z]/.test(t) && /[0-9]/.test(t)))];
  longTok[path.basename(file)] = { count: toks.length, samples: toks.slice(0, 6).map((t) => `${fp(t)}(${t.length})`) };
}
P("  高熵长串（≥24 位，只报条数与指纹，便于人工核对）：" + JSON.stringify(longTok));
P(`\n结论：真实密钥命中 ${leak} 处 → ${leak === 0 ? "无泄漏 ✅" : "有泄漏 ❌，需清理后重跑"}`);
fs.writeFileSync(path.join(runDir, "audit-report.txt"), out.join("\n") + "\n", "utf8");
P(`（已写 ${path.join(runDir, "audit-report.txt")}）`);

/* arm-stats.mjs — 通用多臂校准 / 配对统计（臂名参数化，不改任何数据，只读 results.jsonl）
   用法：node scripts/bench/arm-stats.mjs <runName> <armA,armB[,armC,armD]> [--out <file>] [--baseline-run full]
   每个臂单独出一段矩阵（含按数据集分层，数据集从数据里枚举，不写死）；配对段只取前两臂。
   口径与 full 那次一致（token 分列、生效档、耗时、正文 = output − reasoning）。 */
import fs from "node:fs";
import path from "node:path";

const run = process.argv[2] || "full2";
const arms = (process.argv[3] || "code,minimal").split(",").map((s) => s.trim()).filter(Boolean);
const outI = process.argv.indexOf("--out");
const outFile = outI > 0 ? process.argv[outI + 1] : "";
const baseI = process.argv.indexOf("--baseline-run");
const baselineRun = baseI > 0 ? process.argv[baseI + 1] : "";
const root = path.join(process.env.LOCALAPPDATA, "mtnode-bench", "runs");

/* 与 score.mjs 同口径：同 (dataset,id,arm) 只取**最后一条**参与分布（重试的失败/超时行不重复计入），
   重跑次数在表头单独报出。 */
const lastAttempt = (rows) => { const m = new Map(); for (const r of rows) m.set(`${r.dataset}|${r.id}|${r.arm}`, r); return [...m.values()]; };
const load = (name) => {
  const file = path.join(root, name, "results.jsonl");
  const rows = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const notWarm = rows.filter((r) => !r.warmup);
  return { rows, scoredRaw: notWarm, scored: lastAttempt(notWarm), warm: rows.filter((r) => r.warmup) };
};
const cur = load(run);
const base = baselineRun ? load(baselineRun) : null;

const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const q = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const f = (n) => Number(n).toFixed(Math.abs(n) >= 100 ? 0 : 1);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const totIn = (r) => (r.usage.inputTokens || 0) + (r.usage.cacheReadTokens || 0) + (r.usage.cacheWriteTokens || 0);
const totAll = (r) => totIn(r) + (r.usage.outputTokens || 0);
const keyOf = (r) => r.dataset + "|" + r.id;
/* 成本口径与 score.mjs 一致：高峰价 输入未命中 3.0 / 缓存写 3.0 / 缓存读 0.10 / 输出 9.0（元/百万 token） */
const cost = (r) => ((r.usage.inputTokens || 0) * 3.0 + (r.usage.cacheReadTokens || 0) * 0.10 + (r.usage.cacheWriteTokens || 0) * 3.0 + (r.usage.outputTokens || 0) * 9.0) / 1e6;

const lines = [];
const P = (s = "") => lines.push(s);

P(`# run=${run}  arms=${arms.join(",")}  计分 ${cur.scored.length} 题·臂（原始 ${cur.scoredRaw.length} 行，重试 ${cur.scoredRaw.length - cur.scored.length} 行已按最后一条归并） / 总 ${cur.rows.length} 行（预热 ${cur.warm.length}）`);
P(`# 生成时间 ${new Date().toISOString()}`);

/* 数据集分层从数据里枚举（不写死），新增基准集自动进矩阵 */
const dataSets = [...new Set(cur.scored.map((r) => r.dataset))];
P(`# 数据集：${dataSets.join(", ")}`);

for (const arm of arms) {
  const rs = cur.scored.filter((r) => r.arm === arm);
  if (!rs.length) { P(`\n===== ${arm}  n=0（无数据）=====`); continue; }
  const sum = (k) => rs.reduce((a, r) => a + (r.usage[k] || 0), 0);
  const ti = rs.reduce((a, r) => a + totIn(r), 0);
  const wall = rs.map((r) => r.metrics?.wallMs || 0);
  const out = rs.map((r) => r.usage.outputTokens || 0);
  const rea = rs.map((r) => r.usage.reasoningTokens || 0);
  const txt = rs.map((r) => r.streamed?.textChars || 0);
  P(`\n===== ${arm}  n=${rs.length}  ok=${rs.filter((r) => r.status === "ok").length}  生效档=${[...new Set(rs.map((r) => r.effortEffective))].join("/")} =====`);
  P("  合计: 非缓存输入 " + sum("inputTokens") + " | 缓存读 " + sum("cacheReadTokens") + " | 输入总计 " + ti + " | 输出 " + sum("outputTokens") + " (思考 " + sum("reasoningTokens") + " | 正文 " + (sum("outputTokens") - sum("reasoningTokens")) + ")");
  P("  每题均值: 输入 " + f(ti / rs.length) + " | 输出 " + f(sum("outputTokens") / rs.length) + " | 思考 " + f(sum("reasoningTokens") / rs.length) + " | 正文 " + f((sum("outputTokens") - sum("reasoningTokens")) / rs.length));
  P("  每题中位: 输入 " + f(med(rs.map(totIn))) + " | 输出 " + f(med(out)) + " | 思考 " + f(med(rea)) + " | 全量token " + f(med(rs.map(totAll))));
  P("  字符: 思考中位 " + f(med(rs.map((r) => r.streamed?.reasoningChars || 0))) + " | 答复中位 " + f(med(txt)) + " | 答复最短 " + Math.min(...txt));
  P("  耗时: 网关wallMs 中位 " + f(med(wall)) + " | 均值 " + f(mean(wall)) + " | P90 " + f(q(wall, .9)) + " | P99 " + f(q(wall, .99)) + " | 最大 " + Math.max(...wall));
  P("  宿主墙钟均值 " + f(mean(rs.map((r) => r.runnerWallMs || 0))) + "ms | 首字延均值 " + f(mean(rs.map((r) => r.metrics?.firstTokenAvgMs || 0))) + "ms | 首字延中位 " + f(med(rs.map((r) => r.metrics?.firstTokenAvgMs || 0))) + "ms | tok/s 中位 " + f(med(rs.map((r) => r.metrics?.tokPerSec || 0))));
  P("  缓存命中中位 " + f(med(rs.map((r) => r.metrics?.cacheHitPct || 0))) + "% | steps均值 " + f(mean(rs.map((r) => r.metrics?.steps || 0))) + " | 工具调用 " + rs.reduce((a, r) => a + (r.streamed?.toolCalls || 0), 0) + " | calls " + rs.reduce((a, r) => a + (r.usage.calls || 0), 0));
  P("  交互 " + JSON.stringify(rs.reduce((a, r) => { for (const k in (r.interactions || {})) a[k] = (a[k] || 0) + r.interactions[k]; return a; }, {})));
  P("  outTok  P50 " + f(q(out, .5)) + "  P90 " + f(q(out, .9)) + "  P99 " + f(q(out, .99)) + "  max " + f(Math.max(...out)));
  P("  reaTok  P50 " + f(q(rea, .5)) + "  P90 " + f(q(rea, .9)) + "  P99 " + f(q(rea, .99)) + "  max " + f(Math.max(...rea)));
  P("  答复字符 P50 " + f(q(txt, .5)) + "  P90 " + f(q(txt, .9)) + "  min " + f(Math.min(...txt)) + "  | 空答复(<20ch) " + txt.filter((x) => x < 20).length + "  <=80ch " + txt.filter((x) => x <= 80).length);
  P("  多步/工具 runs: " + (rs.filter((r) => (r.metrics?.steps || 0) > 1 || (r.streamed?.toolCalls || 0) > 0).map((r) => r.dataset + "|" + r.id + " steps=" + r.metrics?.steps + " tool=" + r.streamed?.toolCalls).join(", ") || "无"));
  P("  status 分布: " + JSON.stringify(rs.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {})) + "  finalResponse 为空: " + rs.filter((r) => !String(r.finalResponse || "").trim()).length);
  P("  成本(高峰价口径) 合计 ¥" + rs.reduce((a, r) => a + cost(r), 0).toFixed(6) + " | 每次均值 ¥" + (rs.reduce((a, r) => a + cost(r), 0) / rs.length).toFixed(6));
  for (const ds of dataSets) {
    const g = rs.filter((r) => r.dataset === ds);
    if (!g.length) continue;
    const gr = g.map((r) => r.usage.reasoningTokens || 0), go = g.map((r) => r.usage.outputTokens || 0);
    const body = go.map((v, i) => v - gr[i]);
    const gw = g.map((r) => r.metrics?.wallMs || 0);
    P("  " + ds + ": n=" + g.length + " 输出均值 " + f(mean(go)) + " 思考均值 " + f(mean(gr)) + " 正文均值 " + f(mean(body)) + " 正文中位 " + f(med(body)) + " 思考中位 " + f(med(gr)) + " wall中位 " + f(med(gw)) + "ms P90 " + f(q(gw, .9)) + "ms P99 " + f(q(gw, .99)) + "ms max " + f(Math.max(...gw)));
  }
}

P("\n预热(不计分): " + (cur.warm.map((w) => w.arm + " " + w.status + " in=" + totIn(w) + " out=" + w.usage.outputTokens + " wall=" + (w.metrics?.wallMs ?? "?") + "ms").join("  |  ") || "无"));

const [A, B] = arms;
const byKey = {};
for (const r of cur.scored) (byKey[keyOf(r)] ||= {})[r.arm] = r;
let n = 0, bLowTok = 0, bFast = 0, bLowRea = 0, bLowBody = 0, bLowCost = 0, bLowOut = 0;
const dTok = [], dWall = [], dRea = [], dOut = [], dCost = [];
const longA = [], longB = [];
for (const k in byKey) {
  const a = byKey[k][A], b = byKey[k][B];
  if (!a || !b) continue;
  n++;
  const ta = totAll(a), tb = totAll(b);
  const ra = a.usage.reasoningTokens || 0, rb = b.usage.reasoningTokens || 0;
  const ba = (a.usage.outputTokens || 0) - ra, bb = (b.usage.outputTokens || 0) - rb;
  dTok.push((tb - ta) / ta * 100);
  const wa = a.metrics?.wallMs || 0, wb = b.metrics?.wallMs || 0;
  if (wa > 0) dWall.push((wb - wa) / wa * 100);
  dRea.push(rb - ra);
  dOut.push((b.usage.outputTokens || 0) - (a.usage.outputTokens || 0));
  dCost.push((cost(b) - cost(a)) / cost(a) * 100);
  if (tb < ta) bLowTok++;
  if (rb < ra) bLowRea++;
  if (bb < ba) bLowBody++;
  if ((b.usage.outputTokens || 0) < (a.usage.outputTokens || 0)) bLowOut++;
  if (wb < wa) bFast++;
  if (cost(b) < cost(a)) bLowCost++;
  if (wa > 15000) longA.push(k);
  if (wb > 15000) longB.push(k);
}
P(`\n配对 n=${n}（耗时百分比只统计 ${dWall.length} 对基准墙钟有效的题）: ${B} 全量 token 更低 ${bLowTok}/${n}，平均 ${f(mean(dTok))}% 中位 ${f(med(dTok))}%（P10 ${f(q(dTok, .1))}%）`);
P(`  ${B} 输出更低 ${bLowOut}/${n} 平均 ${f(mean(dOut))} tok | 思考更低 ${bLowRea}/${n} 差值均值 ${f(mean(dRea))} 中位 ${f(med(dRea))} | 正文更低 ${bLowBody}/${n}`);
P(`  ${B} 更快 ${bFast}/${n}，平均 ${f(mean(dWall))}% 中位 ${f(med(dWall))}%（P10 ${f(q(dWall, .1))}%）| ${B} 成本更低 ${bLowCost}/${n} 平均 ${f(mean(dCost))}%`);
P(`  wall>15s 题数: ${A} ${longA.length} vs ${B} ${longB.length}  明细 ${A}=[${longA.join(" ")}] ${B}=[${longB.join(" ")}]`);

if (base) {
  P("\n----- 与 run=" + baselineRun + " 的同题横向对照（分离「人设前缀长度」与「思考降档」两刀） -----");
  for (const [bArm, bRows] of [["standard", base.scored.filter((r) => r.arm === "standard")], ["lean", base.scored.filter((r) => r.arm === "lean")]]) {
    if (!bRows.length) continue;
    const byB = new Map(bRows.map((r) => [keyOf(r), r]));
    P(`  [基准 ${baselineRun}/${bArm}] n=${bRows.length} 输出均值 ${f(mean(bRows.map((r) => r.usage.outputTokens || 0)))} 思考均值 ${f(mean(bRows.map((r) => r.usage.reasoningTokens || 0)))} 思考中位 ${f(med(bRows.map((r) => r.usage.reasoningTokens || 0)))} wall中位 ${f(med(bRows.map((r) => r.metrics?.wallMs || 0)))}ms`);
    for (const arm of arms) {
      const rs = cur.scored.filter((r) => r.arm === arm).filter((r) => byB.has(keyOf(r)));
      if (!rs.length) continue;
      const dd = [], ddr = [];
      let reaWin = 0;
      for (const r of rs) {
        const s = byB.get(keyOf(r));
        dd.push((totAll(r) - totAll(s)) / totAll(s) * 100);
        ddr.push((r.usage.reasoningTokens || 0) - (s.usage.reasoningTokens || 0));
        if ((r.usage.reasoningTokens || 0) < (s.usage.reasoningTokens || 0)) reaWin++;
      }
      P(`    vs ${arm}(full2) 同题 ${rs.length} 对: 全量token 平均 ${f(mean(dd))}% 中位 ${f(med(dd))}% | 思考更低的题 ${reaWin}/${rs.length} 差值均值 ${f(mean(ddr))} | 输出均值 ${f(mean(rs.map((r) => r.usage.outputTokens || 0)))} 思考均值 ${f(mean(rs.map((r) => r.usage.reasoningTokens || 0)))} wall中位 ${f(med(rs.map((r) => r.metrics?.wallMs || 0)))}ms`);
    }
  }
}

const per = mean(cur.scored.map((r) => r.runnerWallMs || 0)) / 1000;
const allIn = cur.scored.reduce((a, r) => a + totIn(r), 0), allOut = cur.scored.reduce((a, r) => a + (r.usage.outputTokens || 0), 0);
P("\n单次运行平均宿主墙钟 " + f(per) + "s；每次平均输入 " + f(allIn / cur.scored.length) + " tok（缓存读 " + f(cur.scored.reduce((a, r) => a + (r.usage.cacheReadTokens || 0), 0) / allIn * 100) + "%），输出 " + f(allOut / cur.scored.length) + " tok");
P("网关 wallMs 合计 " + f(cur.scored.reduce((a, r) => a + (r.metrics?.wallMs || 0), 0) / 1000) + "s；宿主墙钟合计 " + f(cur.scored.reduce((a, r) => a + (r.runnerWallMs || 0), 0) / 1000) + "s");
P("成本(高峰价口径) " + arms.map((a) => `${a}=¥${(cur.scored.filter((r) => r.arm === a).reduce((x, r) => x + cost(r), 0)).toFixed(6)}`).join("  "));

const text = lines.join("\n") + "\n";
if (outFile) fs.writeFileSync(outFile, text, "utf8");
console.log(text);

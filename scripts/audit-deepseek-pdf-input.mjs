#!/usr/bin/env node
/* audit-deepseek-pdf-input.mjs — DeepSeek 官方 API 是否支持「直接输入 PDF」的实测探针
 *
 * 只读探针：不改产线代码、不新增依赖（Node >= 22 内置 fetch / FormData / Blob）。
 * 从本机 %APPDATA%\pipeline-console\pipeline-console\config.json 读 deepseek provider
 * 的 baseUrl + apiKey，与 deepseek-v4-flash-vision-exp / deepseek-v4-flash 两个模型，
 * 对真实论文 PDF 依次尝试四种下发方式，并把 HTTP 状态 / 错误码 / 响应原文落盘。
 *
 * 判定口径：服务端能答出文档内事实（标题 / 作者 / arXiv 号 / 摘要里的渐近式）才算「支持」，
 * 仅 200 空回复、或只回一句「我看不到附件」一律算「不支持」。
 *
 * 用法：
 *   node scripts/audit-deepseek-pdf-input.mjs [--pdf <path>] [--model <id>] [--out <dir>] [--timeout <ms>]
 * 日志：%TEMP%\mtnode-pdf-probe\
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/* ---------- 参数与常量 ---------- */

const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const PDF_PATH = argOf(
  "pdf",
  "E:\\xwechat_files\\StorMx_fcaf\\msg\\file\\2026-09\\MOMENTS OF RANDOM MULTIPLICATIVE FUNCTIONS, I.pdf",
);
const OUT_DIR = argOf("out", path.join(os.tmpdir(), "mtnode-pdf-probe"));
const TIMEOUT_MS = Number(argOf("timeout", "240000"));
const PROVIDER_ID = argOf("provider", "deepseek");
const MODELS = (() => {
  const m = argOf("model", "");
  return m ? [m] : ["deepseek-v4-flash-vision-exp", "deepseek-v4-flash"];
})();

/* 文档内事实（由本机 pdftotext 提取的前两页文本核对得到，见同目录 ground_truth_p1-2.txt） */
const TRUTH = {
  titleKeywords: ["MOMENTS OF RANDOM MULTIPLICATIVE FUNCTIONS"],
  author: "ADAM J HARPER",
  arxiv: "1703.06654",
  /* 摘要里那条渐近式：E|Σ_{n≤x} f(n)| ≍ √x/(log log x)^{1/4} */
  formulaKeywords: ["log log", "1/4", "sqrt", "\\surd", "≍", "asymp"],
};

const Q_FACTS =
  "I am sending you a document. Answer only from the document itself. " +
  "Give (1) the exact full title, (2) the author's name, (3) the arXiv identifier with version if shown. " +
  "If you cannot read any document, reply exactly: NO_DOCUMENT_ACCESS";
const Q_FORMULA =
  "Using the same document: transcribe verbatim, in LaTeX, the asymptotic formula for the first moment " +
  "E|sum_{n<=x} f(n)| that is stated in the Abstract. Keep the constant and the power of log log x exact. " +
  "If you cannot read the document, reply exactly: NO_DOCUMENT_ACCESS";

/* ---------- 落盘 ---------- */

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_PATH = path.join(OUT_DIR, `deepseek-pdf-probe-${stamp}.log`);
const JSONL_PATH = path.join(OUT_DIR, `deepseek-pdf-probe-${stamp}.jsonl`);
const lines = [];

function log(s) {
  const line = typeof s === "string" ? s : JSON.stringify(s);
  lines.push(line);
  console.log(line);
}
function record(obj) {
  fs.appendFileSync(JSONL_PATH, JSON.stringify(obj) + "\n", "utf8");
}
function flush() {
  fs.writeFileSync(LOG_PATH, lines.join("\n") + "\n", "utf8");
  log(`\n[log] ${LOG_PATH}`);
  log(`[jsonl] ${JSONL_PATH}`);
}

/* ---------- 配置读取 ---------- */

function configCandidates() {
  const cands = [];
  if (process.env.APPDATA) {
    cands.push(path.join(process.env.APPDATA, "pipeline-console", "pipeline-console", "config.json"));
    cands.push(path.join(process.env.APPDATA, "pipeline-console", "config.json"));
  }
  cands.push(path.join(os.homedir(), ".config", "pipeline-console", "config.json"));
  return cands;
}

function loadProvider() {
  for (const p of configCandidates()) {
    if (!fs.existsSync(p)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    const list = Array.isArray(json.providers) ? json.providers : [];
    const hit = list.find((x) => x && (x.id === PROVIDER_ID || x.name === PROVIDER_ID));
    if (!hit) continue;
    if (!hit.apiKey) throw new Error(`provider ${PROVIDER_ID} 存在但没有 apiKey：${p}`);
    return {
      configPath: p,
      id: hit.id || hit.name,
      baseUrl: String(hit.baseUrl || "").replace(/\/+$/, ""),
      apiKey: String(hit.apiKey),
      vision: !!hit.vision,
    };
  }
  throw new Error("找不到 deepseek provider 配置：" + configCandidates().join(" | "));
}

/* ---------- HTTP ---------- */

function maskKey(k) {
  return k ? k.slice(0, 6) + "…" + k.slice(-4) + ` (len=${k.length})` : "(none)";
}
function brief(s, n = 700) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + " …[+%d chars]" : t;
}

async function httpJson(url, init, label) {
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await res.text();
  } catch (e) {
    const out = { label, url, ok: false, netError: String(e && e.message ? e.message : e), ms: Date.now() - t0 };
    log(`  ✗ ${label} 网络/超时失败：${out.netError} (${out.ms}ms)`);
    record({ kind: "http", ...out });
    return out;
  }
  const ms = Date.now() - t0;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON：可能是 HTML 网关错误页 */
  }
  const out = {
    label,
    url,
    status: res.status,
    httpOk: res.ok,
    ms,
    contentType: res.headers.get("content-type") || "",
    errorCode: json && json.error ? json.error.code ?? null : null,
    errorType: json && json.error ? json.error.type ?? null : null,
    errorMessage: json && json.error ? brief(json.error.message, 500) : null,
    rawHead: brief(text, 900),
    json,
  };
  log(
    `  → ${label} HTTP ${res.status} (${ms}ms)` +
      (out.errorCode || out.errorMessage ? ` err=${out.errorCode || ""} ${brief(out.errorMessage || "", 200)}` : ""),
  );
  record({
    kind: "http",
    label,
    url,
    status: out.status,
    httpOk: out.httpOk,
    ms,
    contentType: out.contentType,
    errorCode: out.errorCode,
    errorType: out.errorType,
    errorMessage: out.errorMessage,
    rawHead: out.rawHead,
  });
  return out;
}

/* ---------- 判定 ---------- */

function answerText(json) {
  const m = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!m) return { content: "", reasoning: "", finish: null };
  return {
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
    reasoning: typeof m.reasoning_content === "string" ? m.reasoning_content : "",
    finish: json.choices[0].finish_reason ?? null,
  };
}

function judgeFacts(text) {
  const t = String(text || "");
  if (!t.trim() || /NO_DOCUMENT_ACCESS/i.test(t)) return { supported: false, why: "空回复或模型自称没有文档访问权限" };
  const titleHit = TRUTH.titleKeywords.some((k) => t.toUpperCase().includes(k));
  const authorHit = t.toUpperCase().includes(TRUTH.author);
  const arxivHit = t.includes(TRUTH.arxiv);
  const hits = [titleHit, authorHit, arxivHit].filter(Boolean).length;
  if (hits >= 2) return { supported: true, why: `命中 ${hits}/3 项文档事实（标题/作者/arXiv）` };
  if (hits === 1) return { supported: false, why: "仅命中 1 项，疑似猜测——按口径不算支持" };
  return { supported: false, why: "未命中任何文档事实，疑似模型自行编造或未读到附件" };
}

function judgeFormula(text) {
  const t = String(text || "");
  if (!t.trim() || /NO_DOCUMENT_ACCESS/i.test(t)) return { recognized: false, why: "空回复或模型自称没有文档访问权限" };
  const hits = TRUTH.formulaKeywords.filter((k) => t.toLowerCase().includes(k.toLowerCase()));
  const hasLogLog = /log\s*\\?log/.test(t) || t.toLowerCase().includes("log log");
  const hasQuarter = /(1\/4|\\frac\{1\}\{4\}|\^\{?1\/4\}?|\^\{?0?\.25)/.test(t);
  const recognized = hasLogLog && hasQuarter;
  return {
    recognized,
    why: recognized
      ? "公式关键结构齐全（log log x 与 1/4 次幂）"
      : `公式结构不齐：loglog=${hasLogLog} quarter=${hasQuarter} tokens=[${hits.join(",")}]`,
  };
}

/* ---------- chat 请求 ---------- */

async function chat(base, key, model, content, label, extra = {}) {
  const body = {
    model,
    messages: [{ role: "user", content }],
    temperature: 0,
    max_tokens: 2048,
    ...extra,
  };
  const r = await httpJson(
    base + "/chat/completions",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    label,
  );
  if (r.json) {
    const a = answerText(r.json);
    log(`     finish=${a.finish} content=${brief(a.content, 400)}`);
    if (a.reasoning) log(`     reasoning=${brief(a.reasoning, 200)}`);
    record({ kind: "answer", label, model, finish: a.finish, content: a.content, reasoning: a.reasoning });
  }
  return r;
}

/* ---------- 主流程 ---------- */

async function main() {
  log(`# DeepSeek PDF 直传实测  ${new Date().toISOString()}`);
  const prov = loadProvider();
  log(`provider=${prov.id} baseUrl=${prov.baseUrl} apiKey=${maskKey(prov.apiKey)} visionFlag=${prov.vision}`);
  log(`config=${prov.configPath}`);
  log(`pdf=${PDF_PATH}`);

  if (!fs.existsSync(PDF_PATH)) throw new Error("PDF 不存在：" + PDF_PATH);
  const pdfBuf = fs.readFileSync(PDF_PATH);
  const pdfB64 = pdfBuf.toString("base64");
  const pdfSize = fs.statSync(PDF_PATH).size;
  log(`pdfSize=${pdfSize} bytes  base64=${pdfB64.length} chars`);
  record({ kind: "meta", provider: prov.id, baseUrl: prov.baseUrl, pdf: PDF_PATH, pdfSize, models: MODELS });

  /* (0) 端点自检：GET /models、GET /files —— 判断有无原生文件上传面 */
  log("\n## (0) 端点自检");
  const modelsRes = await httpJson(
    prov.baseUrl + "/models",
    { headers: { Authorization: "Bearer " + prov.apiKey } },
    "GET /models",
  );
  const filesRes = await httpJson(
    prov.baseUrl + "/files",
    { headers: { Authorization: "Bearer " + prov.apiKey } },
    "GET /files",
  );
  log(
    `  结论：/models ${modelsRes.httpOk ? "存在" : "不可用(" + modelsRes.status + ")"} · ` +
      `/files ${filesRes.httpOk ? "存在" : "不可用(" + filesRes.status + ")"}`,
  );
  record({
    kind: "endpoints",
    models: { status: modelsRes.status, ok: modelsRes.httpOk },
    files: { status: filesRes.status, ok: filesRes.httpOk, error: filesRes.errorMessage },
  });

  const dataUrl = "data:application/pdf;base64," + pdfB64;

  for (const model of MODELS) {
    log(`\n===== model: ${model} =====`);
    record({ kind: "model-start", model });
    /* 记录本模型第一条真正读到文档的通道，供 (e) 公式专项复用 */
    let workingRef = null;

    /* (a) 纯文本提问（对照组）：不给任何附件，只问文档内容 */
    log("\n## (a) 纯文本提问（对照：无附件）");
    const a = await chat(prov.baseUrl, prov.apiKey, model, Q_FACTS, `${model} | a-plain-text`);
    const aAns = a.json ? answerText(a.json) : { content: "" };
    const aJudge = judgeFacts(aAns.content);
    log(`  判定：${aJudge.supported ? "支持" : "不支持"} — ${aJudge.why}`);
    record({ kind: "verdict", model, attempt: "a-plain-text", supported: aJudge.supported, why: aJudge.why });

    /* (b) content 数组 + {type:'file', file:{file_data}} —— OpenAI 兼容的原生 PDF 附件写法 */
    log("\n## (b) file part: {type:'file',file:{file_data:'data:application/pdf;base64,…'}}");
    const b = await chat(
      prov.baseUrl,
      prov.apiKey,
      model,
      [
        { type: "text", text: Q_FACTS },
        { type: "file", file: { filename: path.basename(PDF_PATH), file_data: dataUrl } },
      ],
      `${model} | b-file-part`,
    );
    if (b.json) {
      const ans = answerText(b.json);
      const j = judgeFacts(ans.content);
      log(`  判定：${j.supported ? "支持" : "不支持"} — ${j.why}`);
      record({ kind: "verdict", model, attempt: "b-file-part", supported: j.supported, why: j.why });
    } else {
      record({ kind: "verdict", model, attempt: "b-file-part", supported: false, why: b.netError || "非 JSON 响应" });
    }

    /* (b2) file_data 变体：裸 base64（不带 data: 前缀）—— 服务端报「must have a file_id or file_data」，
       说明它认 'file' 这个 part，但没吃到我们给的 file_data 形式，逐一试已知写法 */
    log("\n## (b2) file part: file_data = 裸 base64（无 data: 前缀）");
    const b2 = await chat(
      prov.baseUrl,
      prov.apiKey,
      model,
      [
        { type: "text", text: Q_FACTS },
        { type: "file", file: { file_data: pdfB64 } },
      ],
      `${model} | b2-file-data-raw-b64`,
    );
    if (b2.json) {
      const j = judgeFacts(answerText(b2.json).content);
      log(`  判定：${j.supported ? "支持" : "不支持"} — ${j.why}`);
      record({ kind: "verdict", model, attempt: "b2-file-data-raw-b64", supported: j.supported, why: j.why });
      if (j.supported) workingRef = { label: "b2-file-data-raw-b64", part: { type: "file", file: { file_data: pdfB64 } } };
    } else {
      record({ kind: "verdict", model, attempt: "b2-file-data-raw-b64", supported: false, why: b2.netError || "非 JSON 响应" });
    }

    /* (b3) file_data 变体：{type:'input_file'} —— 部分兼容层用的别名 */
    log("\n## (b3) input_file part: {type:'input_file',file_data:'data:application/pdf;base64,…'}");
    const b3 = await chat(
      prov.baseUrl,
      prov.apiKey,
      model,
      [
        { type: "text", text: Q_FACTS },
        { type: "input_file", file_data: dataUrl },
      ],
      `${model} | b3-input-file`,
    );
    if (b3.json) {
      const j = judgeFacts(answerText(b3.json).content);
      log(`  判定：${j.supported ? "支持" : "不支持"} — ${j.why}`);
      record({ kind: "verdict", model, attempt: "b3-input-file", supported: j.supported, why: j.why });
      if (j.supported) workingRef = { label: "b3-input-file", part: { type: "input_file", file_data: dataUrl } };
    } else {
      record({ kind: "verdict", model, attempt: "b3-input-file", supported: false, why: b3.netError || "非 JSON 响应" });
    }

    /* (b4) file part 的其余已知拼写：file_data 放 part 顶层 / 放 file.data */
    const bVariants = [
      { label: "b4-file-data-top-level", part: { type: "file", file_data: dataUrl } },
      { label: "b5-file-data-key-data", part: { type: "file", file: { data: dataUrl } } },
      { label: "b6-file-url", part: { type: "file", file: { url: dataUrl } } },
    ];
    for (const v of bVariants) {
      log(`\n## (${v.label}) file part 拼写变体`);
      const r = await chat(
        prov.baseUrl,
        prov.apiKey,
        model,
        [{ type: "text", text: Q_FACTS }, v.part],
        `${model} | ${v.label}`,
      );
      if (r.json) {
        const j = judgeFacts(answerText(r.json).content);
        log(`  判定：${j.supported ? "支持" : "不支持"} — ${j.why}`);
        record({ kind: "verdict", model, attempt: v.label, supported: j.supported, why: j.why });
        if (j.supported && !workingRef) workingRef = { label: v.label, part: v.part };
      } else {
        record({ kind: "verdict", model, attempt: v.label, supported: false, why: r.netError || "非 JSON 响应" });
      }
    }

    /* (c) image_url 承载 PDF data URL —— 常见误用写法，实测是否被拒 */
    log("\n## (c) image_url part 承载 application/pdf data URL（误用写法，验其拒绝面）");
    const c = await chat(
      prov.baseUrl,
      prov.apiKey,
      model,
      [
        { type: "text", text: Q_FACTS },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
      `${model} | c-image-url-pdf`,
    );
    if (c.json) {
      const ans = answerText(c.json);
      const j = judgeFacts(ans.content);
      log(`  判定：${j.supported ? "支持" : "不支持"} — ${j.why}`);
      record({ kind: "verdict", model, attempt: "c-image-url-pdf", supported: j.supported, why: j.why });
    } else {
      record({ kind: "verdict", model, attempt: "c-image-url-pdf", supported: false, why: c.netError || "非 JSON 响应" });
    }

    /* (d) 若 /files 存在：multipart 上传拿 file_id，再用 {type:'file',file:{file_id}} 引用 */
    log("\n## (d) 文件上传面（仅当 /files 可用时）");
    if (!filesRes.httpOk) {
      log(`  跳过：/files HTTP ${filesRes.status} ${filesRes.errorMessage || ""}`);
      record({ kind: "verdict", model, attempt: "d-files-upload", supported: false, why: `无 /files 端点（HTTP ${filesRes.status}）` });
    } else {
      const fd = new FormData();
      /* 服务端明确回：「Supported purposes: ["user_data"]」——按它接受的值上传 */
      fd.append("purpose", "user_data");
      fd.append("file", new Blob([pdfBuf], { type: "application/pdf" }), path.basename(PDF_PATH));
      const up = await httpJson(
        prov.baseUrl + "/files",
        { method: "POST", headers: { Authorization: "Bearer " + prov.apiKey }, body: fd },
        `${model} | d-upload`,
      );
      const fileId = up.json && up.json.id;
      if (!fileId) {
        log("  上传未返回 file_id，跳过引用步骤");
        record({ kind: "verdict", model, attempt: "d-files-upload", supported: false, why: "上传未返回 file_id" });
      } else {
        log(`  file_id=${fileId}`);
        const d = await chat(
          prov.baseUrl,
          prov.apiKey,
          model,
          [
            { type: "text", text: Q_FACTS },
            { type: "file", file: { file_id: fileId } },
          ],
          `${model} | d-file-id-ref`,
        );
        if (d.json) {
          const ans = answerText(d.json);
          const j = judgeFacts(ans.content);
          log(`  判定：${j.supported ? "支持" : "不支持"} — ${j.why}`);
          record({ kind: "verdict", model, attempt: "d-file-id-ref", supported: j.supported, why: j.why });
          if (j.supported) workingRef = { label: "d-file-id-ref", part: { type: "file", file: { file_id: fileId } } };
        } else {
          record({ kind: "verdict", model, attempt: "d-file-id-ref", supported: false, why: d.netError || "非 JSON 响应" });
        }
      }
    }

    /* 公式专项：只有确实能读到文档的通道才值得问公式 */
    log("\n## (e) 公式转写（在本模型唯一跑通的通道上再问一次）");
    if (!workingRef) {
      log("  跳过：本模型没有任何通道读到了文档（见上文逐条 HTTP 错误）");
      record({ kind: "verdict", model, attempt: "e-formula", supported: false, why: "无可用 PDF 通道" });
    } else {
      log(`  使用通道：${workingRef.label}`);
      const e = await chat(
        prov.baseUrl,
        prov.apiKey,
        model,
        [{ type: "text", text: Q_FORMULA }, workingRef.part],
        `${model} | e-formula`,
      );
      if (e.json) {
        const ans = answerText(e.json);
        const j = judgeFormula(ans.content);
        log(`  公式判定：${j.recognized ? "识别正确" : "未识别"} — ${j.why}`);
        record({ kind: "verdict", model, attempt: "e-formula", supported: j.recognized, why: j.why });
      } else {
        record({ kind: "verdict", model, attempt: "e-formula", supported: false, why: e.netError || "非 JSON 响应" });
      }
    }
  }

  log("\n# 完成");
}

main()
  .catch((e) => {
    log("\n!! 探针异常：" + (e && e.stack ? e.stack : String(e)));
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      flush();
    } catch {
      /* 忽略落盘失败 */
    }
  });

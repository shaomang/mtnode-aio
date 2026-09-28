"use strict";
/* 内置工具「PDF 转 Markdown」/「Markdown 转 PDF」—— 链路级冒烟测试（纯 Node · 零依赖）
 *   node test/smoke-pdf-tool.js
 *
 * 被测代码都是「真实源码 / 真实模块」，不是抄一份逻辑：
 *   renderer/preset-tools.json   内置条目形状（工具壳 + 内部函数子节点 + 参数表 +
 *                                内侧桥接 / 汇流线 + presets + always）—— 两条内置条目
 *   renderer/app.js              真实切片 superInternalOutFeedsAll /
 *                                superInternalBridgeWires（连同 nodeByIdIn /
 *                                nodeParentSuperId / isControlKind / isToolNode /
 *                                fnToolInPortIsControl / superInPortIsControl 等），
 *                                在 vm 里验证条目那几条内部线的形状被引擎认得
 *   fn-runtime.js                mtnode 桥暴露 readPdf / pdfInfo / writePdf、pdfArg /
 *                                pdfWriteArg 入参归一、createFnRuntime 的 dispatchProc
 *                                分支与「未接线」报错；并用真 worker 跑（未接线 /
 *                                注入 pdfConvert · pdfWrite）
 *   fn-runtime.js                runUserFunction 真跑条目里的 jscode（假 mtnode 注入）
 *   main.js                      注入 fnRuntime.pdfConvert / pdfWrite + fnPdfRead 只调内核三只
 *                                （pdfLoadBuffer / pdfParseBuffer / pdfProbeBuffer）、
 *                                fnPdfWrite 只调 pdf-write.js 的 writeTextPdf；
 *                                把主进程 PDF 内核区段切进 vm，对最小合法 PDF **真跑**
 *                                一次解析回 markdown，并核对失败形状与「只读不落盘」
 *   tools-store.js               内置条目并入 tools:list / tools:get、默认 always=true、
 *                                开关覆写写数据目录、改名 / 删除被拒
 *   renderer/i18n.js             新报错词条中英成对
 *   build.json                   白名单无需新增（renderer/** 已随包、桥未 require 新根模块）
 * 覆盖：
 *   [1] 内置条目形状（kind / 壳 / 子节点 / 入出参 / presets / always）
 *   [2] 引擎认得那几条内部线（app.js 真实切片 · vm）
 *   [3] fn-runtime 桥 + dispatchProc（未接线 / 注入后真跑）
 *   [4] runUserFunction 真跑 jscode（假 mtnode：入参取值 / 不落盘 / 才 writeText / 出错）
 *   [5] main.js 契约 + 最小 PDF 真跑解析（成功 / 加密 / 非 PDF / 无入参 / 只读）
 *   [6] 工具库默认内置（两条）+ i18n 中英成对 + 打包白名单
 *   [7] 内置工具「Markdown 转 PDF」+ mtnode.writePdf（Agent 可调用 → 真出 PDF 文件）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function eq(a, b, msg) {
  ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
}
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* 从源码里抠出顶层函数体（与其它冒烟脚本同一份口径） */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error("函数体不闭合：" + name);
}

/* 最小合法 PDF（无 xref，走全文件扫描兜底）：一页 + 一条未压缩内容流 + 一句文本 */
const MINI_PDF = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
  "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  "5 0 obj << /Length 44 >> stream",
  "BT /F1 24 Tf 72 700 Td (Hello MTNode PDF) Tj ET",
  "endstream endobj",
  "trailer << /Root 1 0 R /Size 6 >>",
  "%%EOF",
  "",
].join("\n");
const ENC_PDF = MINI_PDF.replace("/Size 6 >>", "/Size 6 /Encrypt 9 0 R >>");

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-pdf-tool-"));

  /* ═════════════════ [1] 内置条目形状 ═════════════════ */
  console.log("\n[1] 内置条目形状（kind / 壳 / 子节点 / 入出参 / presets / always）");
  const MANIFEST = JSON.parse(read("renderer/preset-tools.json"));
  const entry = (MANIFEST.tools || []).find((t) => t.key === "pdf-to-markdown");
  ok(!!entry, "[1] preset-tools.json 有 pdf-to-markdown 内置条目（共 " + (MANIFEST.tools || []).length + " 条）");
  if (!entry) {
    console.log("\nFAILED — 找不到内置条目，后续断言跳过");
    process.exit(1);
  }
  eq(entry.kind, "tool", "[1] 条目 kind = tool（工具条目才带「会话随时可调用」开关）");
  eq(entry.always, true, "[1] always = true：默认作为内置工具（会话不翻开关即可 func call）");
  ok(/PDF/.test(entry.name) && /Markdown/.test(entry.name), "[1] 条目名点明 PDF → Markdown：" + entry.name);
  ok(/文本层/.test(entry.description) && /加密/.test(entry.description), "[1] 描述写清只解析文本层、加密件明确报错（不假装能 OCR）");

  const root = (entry.graph.nodes || []).find((n) => n.id === entry.graph.rootId);
  ok(!!root && root.kind === "super" && root.tool === true && root.db !== true, "[1] 根节点是「工具壳」：super + tool:true（非 db）");
  ok(root && root.parentSuperId === "" && root.parentTaskId === "", "[1] 壳是最外层节点（没有父壳 / 父任务）");
  const tc = (root && root.toolConfig) || {};
  eq(tc.name, entry.name, "[1] 壳的 toolConfig.name 与条目名一致（Agent 调用按同一份取数）");
  eq((entry.inputs || []).map((p) => p.name).join(","), "PDF路径,输出Markdown路径", "[1] 包级输入参数：PDF路径 / 输出Markdown路径");
  eq((entry.outputs || []).map((p) => p.name).join(","), "Markdown,文件路径", "[1] 包级输出参数：Markdown / 文件路径");
  ok(
    (entry.inputs || []).concat(entry.outputs || []).every((p) => p.kind === "text"),
    "[1] 四个端子全是文本（下游纯文本节点可直接接）",
  );

  const fnNodes = (entry.graph.nodes || []).filter((n) => n.kind === "function");
  eq(fnNodes.length, 1, "[1] 内部图恰好一个函数子节点");
  const fnNode = fnNodes[0] || {};
  eq(fnNode.parentSuperId, root.id, "[1] 子节点 parentSuperId 指向壳（内侧线靠它归属）");
  eq((fnNode.inputs || []).map((p) => p.name).join(","), "PDF路径,输出Markdown路径", "[1] 子节点参数表与壳一致");
  eq((fnNode.outputs || []).map((p) => p.name).join(","), "Markdown,文件路径", "[1] 子节点输出表与壳一致");
  eq((tc.inputs || []).map((p) => p.name).join(","), "PDF路径,输出Markdown路径", "[1] 壳 toolConfig 输入表与包级一致");
  eq((tc.outputs || []).map((p) => p.name).join(","), "Markdown,文件路径", "[1] 壳 toolConfig 输出表与包级一致");

  const JC = String(fnNode.jscode || "");
  ok(JC.indexOf("mtnode.readPdf") >= 0, "[1] jscode 走 mtnode.readPdf 取文本层");
  ok(/typeof mtnode\.readPdf !== "function"/.test(JC), "[1] 先探测桥是否存在（老版本上给点名错误而不是 TypeError）");
  ok(JC.indexOf("mtnode.writeText") >= 0 && JC.indexOf("mtnode.abs") >= 0, "[1] 给了输出路径才 writeText（先 abs 归一）");
  ok(/encrypted/.test(JC) && /扫描件/.test(JC), "[1] 加密 / 无文本层两条明确报错分支都在 jscode 里");
  ok(entry.presets && typeof entry.presets["PDF路径"] === "string" && entry.presets["PDF路径"], "[1] 带参数预设（测试台点开就有能跑的样例路径）");

  const wires = entry.graph.wires || [];
  eq(wires.length, 4, "[1] 内部图 4 条线（2 条内侧桥接 + 2 条内侧汇流）");
  const bridgeWires = wires
    .filter((w) => w.from === root.id && w.to === fnNode.id)
    .sort((a, b) => a.fromIndex - b.fromIndex);
  eq(bridgeWires.map((w) => w.fromIndex).join(","), "1,2", "[1] 内侧桥接：壳的输出端子号 = 参数端子号（1 / 2）");
  eq(bridgeWires.map((w) => w.toIndex).join(","), "1,2", "[1] 桥接到子节点同名参数端子（1 / 2）");
  const feedWires = wires
    .filter((w) => w.from === fnNode.id && w.to === root.id)
    .sort((a, b) => a.fromIndex - b.fromIndex);
  eq(feedWires.map((w) => w.fromIndex).join(","), "0,1", "[1] 内侧汇流：子节点 2 个输出参数逐个回壳");
  eq(feedWires.map((w) => w.toIndex).join(","), "0,1", "[1] 汇流落到壳的同号输出端子（0 / 1）");
  ok(wires.every((w) => !w.rel), "[1] 4 条都是数据线（rel 关系线不参与执行）");

  /* ═════════════════ [2] 引擎认得那 4 条内部线 ═════════════════ */
  console.log("\n[2] 引擎认得内部线（app.js 真实切片 · vm）");
  const APP = read("renderer/app.js");
  const sb = {
    console,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    RegExp,
    Object,
    Array,
    Set,
    Map,
    S: { wf: null },
  };
  vm.createContext(sb);
  vm.runInContext(
    [
      fnBody(APP, "nodeParentSuperId"),
      fnBody(APP, "isSuperIoNode"),
      fnBody(APP, "nodeByIdIn"),
      fnBody(APP, "isControlKind"),
      /* 非工具壳分支的依赖（本用例的壳是工具壳，superInPortIsControl 走 tool 分支，
         不看连线；这里只补一个不参与判定的占位） */
      "function nodeEmitsControlOnPort() { return false; }",
      fnBody(APP, "isToolNode"),
      fnBody(APP, "isFunctionNode"),
      fnBody(APP, "isFnToolNode"),
      fnBody(APP, "fnToolInPortIsControl"),
      fnBody(APP, "superExternalInWiresAll"),
      fnBody(APP, "superInPortIsControl"),
      fnBody(APP, "superInternalOutFeedsAll"),
      fnBody(APP, "superInternalOutFeeds"),
      fnBody(APP, "superInternalBridgeWiresAll"),
      fnBody(APP, "superInternalBridgeWires"),
    ].join("\n"),
    sb,
  );
  const G = (name, ...args) => vm.runInContext(name, sb)(...args);
  const wf = {
    nodes: JSON.parse(JSON.stringify(entry.graph.nodes)),
    wires: JSON.parse(JSON.stringify(entry.graph.wires)),
  };
  sb.S.wf = wf;

  const allBridges = G("superInternalBridgeWiresAll", root, wf);
  eq(allBridges.length, 2, "[2] superInternalBridgeWiresAll：2 条内侧桥接被认出（from = 壳）");
  eq(allBridges.map((w) => w.fromIndex).join(","), "1,2", "[2] 按 fromIndex 排序（端子号 1 / 2 顺序稳定）");
  const dataBridges = G("superInternalBridgeWires", root, wf);
  eq(dataBridges.length, 2, "[2] superInternalBridgeWires：两条都是数据桥接（不是控制入）");
  const feedsAll = G("superInternalOutFeedsAll", root, wf);
  eq(feedsAll.length, 2, "[2] superInternalOutFeedsAll：2 条内侧汇流被认出（to = 壳）");
  eq(feedsAll.map((w) => w.toIndex).join(","), "0,1", "[2] 汇流按 toIndex 排序（输出端子号 0 / 1）");
  eq(G("superInternalOutFeeds", root, wf).length, 2, "[2] superInternalOutFeeds：两条都是数据汇流（子节点不是控制类）");
  ok(G("isToolNode", root) === true, "[2] 壳被认成工具节点（端子序号钉死，不随连线漂移）");

  /* 控制入（端子 0）不该被当成数据桥接：加一条探针线再复核 */
  wf.wires.push({ id: "probe-ctrl", from: root.id, to: fnNode.id, fromIndex: 0, toIndex: 0 });
  eq(G("superInternalBridgeWiresAll", root, wf).length, 3, "[2] 多一条 fromIndex 0 的内侧线：All 口径跟着多一条");
  eq(G("superInternalBridgeWires", root, wf).length, 2, "[2] 控制入不算数据桥接（工具壳：输入 0 = 控制入，固定判定）");
  wf.wires.pop();

  /* ═════════════════ [3] fn-runtime 桥 + dispatchProc ═════════════════ */
  console.log("\n[3] fn-runtime 桥暴露 readPdf / pdfInfo + dispatchProc（真 worker）");
  const FNRT = read("fn-runtime.js");
  const FNR = require(path.join(ROOT, "fn-runtime.js"));
  const PROC_HOST = require(path.join(ROOT, "main-proc-host.js"));
  ok(
    /readPdf: \(a, b\) => call\("readPdf", pdfArg\(a, b\)\)/.test(FNRT) &&
      /pdfInfo: \(a, b\) => call\("pdfInfo", pdfArg\(a, b\)\)/.test(FNRT),
    "[3] mtnode 桥暴露 readPdf / pdfInfo（经 pdfArg 归一后 call 出去）",
  );
  ok(
    /action === "readPdf" \|\| action === "pdfInfo"/.test(FNRT),
    "[3] dispatchProc 有 readPdf / pdfInfo 分支",
  );
  ok(
    /deps\.pdfConvert/.test(FNRT) && /PDF 解析后端未接线/.test(FNRT),
    "[3] 没接线时给点名错误（与 screenShot 同口径，不抛）",
  );
  ok(
    /pdfConvertFn\(action === "pdfInfo" \? "info" : "read", p \|\| \{\}\)/.test(FNRT),
    "[3] 按 info / read 两个 action 转发给注入的后端",
  );

  /* 桥本体的入参归一（不经 worker，直接看 call 收到了什么） */
  const callLog = [];
  const bridge = FNR.buildMtnodeBridge({
    call: async (action, payload) => {
      callLog.push({ action, payload });
      return { ok: true };
    },
  });
  ok(typeof bridge.readPdf === "function" && typeof bridge.pdfInfo === "function", "[3] buildMtnodeBridge 产出 readPdf / pdfInfo 两只");
  await bridge.readPdf("C:/docs/a.pdf");
  eq(callLog[0].action, "readPdf", "[3] readPdf(路径) → action readPdf");
  eq(callLog[0].payload.path, "C:/docs/a.pdf", "[3] 字符串第一参按路径归类（像 mtnode.readText）");
  await bridge.readPdf({ bytes: [1, 2] }, { base64: "QUJD" });
  eq(callLog[1].payload.base64, "QUJD", "[3] 第二参 opts 并进对象（不丢）");
  ok(Array.isArray(callLog[1].payload.bytes), "[3] { bytes } 原样透传");
  await bridge.pdfInfo("C:/docs/b.pdf", { page: 1 });
  eq(callLog[2].action, "pdfInfo", "[3] pdfInfo → action pdfInfo");
  eq(callLog[2].payload.path, "C:/docs/b.pdf", "[3] pdfInfo 的路径同样归一");
  eq(callLog[2].payload.page, 1, "[3] opts 透传（page 这种附加参数不被吞）");

  /* 真 worker 跑两条：未接线 → 点名错误；注入 pdfConvert → 真的走 read / info */
  const rtNo = FNR.createFnRuntime({ procHost: PROC_HOST });
  const rNo = await rtNo.run({
    runId: "pdf-smoke-nowire",
    code: 'const r = await mtnode.readPdf("C:/docs/a.pdf"); return r.error;',
    input: {},
  });
  ok(
    rNo.ok === true && /PDF 解析后端未接线/.test(String(rNo.value)) && /pdfConvert/.test(String(rNo.value)),
    "[3] 真跑：未接线时 mtnode.readPdf 回点名错误（既不抛也不给 undefined）· got " + JSON.stringify(rNo.value),
  );

  const seen = [];
  const rtYes = FNR.createFnRuntime({
    procHost: PROC_HOST,
    pdfConvert: async (action, params) => {
      seen.push({ action, params });
      if (action === "info")
        return { ok: true, isPdf: true, parseable: true, pages: 2, encrypted: false, warning: "" };
      return { ok: true, markdown: "# 标题", pages: 2, formulas: [], warning: "" };
    },
  });
  const rYes = await rtYes.run({
    runId: "pdf-smoke-wired",
    code:
      'const a = await mtnode.readPdf("C:/docs/a.pdf");' +
      'const b = await mtnode.pdfInfo("C:/docs/a.pdf");' +
      "return { md: a.markdown, pages: b.pages };",
    input: {},
  });
  ok(rYes.ok === true && rYes.value.md === "# 标题" && rYes.value.pages === 2, "[3] 真跑：注入 pdfConvert 后 readPdf / pdfInfo 都能拿到后端结果");
  eq(seen.length, 2, "[3] 后端被调用 2 次（read 一次 + info 一次）");
  eq(seen[0].action, "read", "[3] readPdf → 后端 action read");
  eq(seen[0].params.path, "C:/docs/a.pdf", "[3] 路径一路透传到后端");
  eq(seen[1].action, "info", "[3] pdfInfo → 后端 action info");
  ok(PROC_HOST.activeProcessCount() === 0, "[3] 两次运行结束后宿主登记表为空（无残留进程）");

  /* ═════════════════ [4] runUserFunction 真跑条目 jscode（假 mtnode） ═════════════════ */
  console.log("\n[4] runUserFunction 真跑条目 jscode（假 mtnode 注入）");
  const MD = "# 标题\n\n正文内容";
  const reads = [];
  const logs = [];
  const writes = [];
  const absCalls = [];
  const fakeBridge = (extra) =>
    Object.assign(
      {
        log: (...a) => logs.push(a.join(" ")),
        abs: (p) => {
          absCalls.push(p);
          return "C:/out/" + String(p).replace(/^.*[\\/]/, "");
        },
        writeText: (p, t) => {
          writes.push({ p, t });
          return p;
        },
        readPdf: async (p) => {
          reads.push(p);
          return { ok: true, markdown: MD, pages: 3, formulas: ["a=1"], warning: "字体缺少 ToUnicode 映射" };
        },
      },
      extra || {},
    );
  const runJc = (input, deps) => FNR.runUserFunction({ code: JC, input: input }, deps);

  {
    const r = await runJc({ 输出Markdown路径: "x.md" }, { mtnode: fakeBridge() });
    ok(r.ok === false && /缺少 PDF 路径/.test(String(r.error)), "[4] 不给 PDF 路径 → 抛「缺少 PDF 路径」（节点上显示 ✕ 与原因）");
    eq(reads.length, 0, "[4] 缺路径时不碰桥（不会拿空路径去读盘）");
  }
  {
    reads.length = 0;
    const r = await runJc({ PDF路径: "C:/docs/a.pdf", 输出Markdown路径: "" }, { mtnode: fakeBridge() });
    ok(r.ok === true, "[4] 只给 PDF 路径 → 正常返回");
    eq(r.value.Markdown, MD, "[4] 输出 Markdown = 桥回的正文");
    eq(r.value["文件路径"], "", "[4] 没给输出路径 → 文件路径为空（不是假路径）");
    eq(writes.length, 0, "[4] 空输出路径不落盘（writeText 一次都没调）");
    eq(absCalls.length, 0, "[4] 空输出路径不调 abs（不做无意义归一）");
    ok(logs.join("\n").indexOf("不落盘") >= 0, "[4] 日志写清「只回 Markdown 文本，不落盘」");
    eq(Object.keys(r.value).sort().join(","), "Markdown,文件路径", "[4] 返回形状就是这两个输出端子（多一个都会污染下游）");
  }
  {
    reads.length = 0;
    writes.length = 0;
    const r = await runJc({ PDF路径: "C:/docs/a.pdf", 输出Markdown路径: "C:\\out\\a.md" }, { mtnode: fakeBridge() });
    eq(r.value["文件路径"], "C:/out/a.md", "[4] 给了输出路径才落盘，并把落盘路径回给输出端子");
    eq(writes.length, 1, "[4] writeText 恰好调一次");
    eq(writes[0].t, MD, "[4] 写盘内容 = 解析出的 Markdown");
    ok(logs.join("\n").indexOf("3 页") >= 0, "[4] 日志带上页数与字数（用户看得见转了多少）");
  }
  {
    reads.length = 0;
    const r = await runJc({ PDF路径: { kind: "text", text: "C:/docs/b.pdf" }, 输出Markdown路径: "" }, { mtnode: fakeBridge() });
    ok(r.ok === true && reads[0] === "C:/docs/b.pdf", "[4] 端子值写成 {kind,text} 对象也认（线上来的就是这种形状）");
  }
  {
    reads.length = 0;
    const r = await runJc({ $1: "C:/docs/c.pdf" }, { mtnode: fakeBridge() });
    ok(r.ok === true && reads[0] === "C:/docs/c.pdf", "[4] 位置兜底：input.$1 也能取到 PDF 路径");
  }
  {
    const r = await runJc(
      { PDF路径: "C:/docs/enc.pdf" },
      { mtnode: fakeBridge({ readPdf: async () => ({ ok: false, error: { code: "encrypted", message: "PDF 已加密，无法解析文本" } }) }) },
    );
    ok(r.ok === false && /已加密/.test(String(r.error)), "[4] 后端回 encrypted → 抛点名错误（不静默成功）");
  }
  {
    const r = await runJc(
      { PDF路径: "C:/docs/scan.pdf" },
      {
        mtnode: fakeBridge({
          readPdf: async () => ({
            ok: true,
            markdown: "",
            pages: 0,
            formulas: [],
            warning: "未提取到文本层（可能是扫描件或图片版 PDF）",
          }),
        }),
      },
    );
    ok(r.ok === false && /扫描件/.test(String(r.error)) && /未提取到文本层/.test(String(r.error)), "[4] 无文本层（扫描件）→ 明确报错并带上后端 warning，不回一篇空文档");
  }
  {
    const r = await runJc({ PDF路径: "C:/docs/a.pdf" }, { mtnode: { log: () => {} } });
    ok(r.ok === false && /不支持 PDF 解析/.test(String(r.error)), "[4] 桥不存在 → 点名「当前 MTNode 不支持 PDF 解析」");
  }
  {
    const r = await runJc({ PDF路径: "C:/docs/a.pdf" }, { mtnode: fakeBridge({ readPdf: async () => ({ ok: false, error: "读取失败" }) }) });
    ok(r.ok === false && /解析失败/.test(String(r.error)), "[4] 后端回错误字符串 → 抛「PDF 解析失败：…」");
  }

  /* ═════════════════ [5] main.js 契约 + 最小 PDF 真跑解析 ═════════════════ */
  console.log("\n[5] main.js 注入 pdfConvert + 最小合法 PDF 真跑解析");
  const MAIN = read("main.js");
  const FNPDF = fnBody(MAIN, "fnPdfRead");
  ok(/pdfConvert: \(action, params\) => fnPdfRead\(action, params\)/.test(MAIN), "[5] main.js 给 fnRuntime 注入 pdfConvert → fnPdfRead");
  ok(
    FNPDF.indexOf("pdfLoadBuffer(") >= 0 && FNPDF.indexOf("pdfParseBuffer(") >= 0 && FNPDF.indexOf("pdfProbeBuffer(") >= 0,
    "[5] fnPdfRead 只调内核三只（pdfLoadBuffer / pdfParseBuffer / pdfProbeBuffer）",
  );
  ok(
    FNPDF.indexOf("pdfScanObjects") < 0 && FNPDF.indexOf("pdfContentToText") < 0 && FNPDF.indexOf("zlib.") < 0,
    "[5] 绝不另写解析器（不在桥里再抄一份扫描 / 内容流抽取）",
  );
  ok(!/writeFileSync|pdfWrite|writeTextPdf/.test(FNPDF), "[5] 只读不落盘：fnPdfRead 里没有任何写盘调用");
  ok(/ipcMain\.handle\(\s*["']pdf:parse["']/.test(MAIN) && /ipcMain\.handle\(\s*["']pdf:probe["']/.test(MAIN), "[5] 既有 pdf:parse / pdf:probe 通道仍在（桥与拖入链同一份内核）");
  eq((MAIN.match(/function pdfLoadBuffer\(/g) || []).length, 1, "[5] pdfLoadBuffer 全仓只有一份（桥没有第二份实现）");

  /* 把主进程 PDF 内核区段切进 vm：没有 electron 也能真跑一次解析 */
  const KERNEL_START = MAIN.indexOf("const PDF_MAX_BYTES = 128");
  const KERNEL_END = MAIN.indexOf("/* pdf:probe：", KERNEL_START);
  ok(KERNEL_START > 0 && KERNEL_END > KERNEL_START, "[5] 找到主进程 PDF 解析内核区段（pdfSourceBuffer … pdfParseBuffer）");
  const ksb = {
    console,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    RegExp,
    Object,
    Array,
    Map,
    Set,
    Buffer,
    fs,
    zlib: require("zlib"),
    I18n: { t: (s) => String(s) },
  };
  vm.createContext(ksb);
  vm.runInContext(MAIN.slice(KERNEL_START, KERNEL_END) + "\n" + FNPDF, ksb);
  const fnPdfRead = vm.runInContext("fnPdfRead", ksb);
  ok(typeof fnPdfRead === "function", "[5] fnPdfRead 在内核沙箱里可执行");

  const pdfPath = path.join(tmpRoot, "mini.pdf");
  fs.writeFileSync(pdfPath, Buffer.from(MINI_PDF, "latin1"));
  const txtPath = path.join(tmpRoot, "not-a.pdf");
  fs.writeFileSync(txtPath, "hello, not a pdf");
  const before = fs.readdirSync(tmpRoot).sort().join(",");
  const miniBuf = Buffer.from(MINI_PDF, "latin1");

  const p1 = await fnPdfRead("read", { bytes: miniBuf });
  ok(p1.ok === true && String(p1.markdown).indexOf("Hello MTNode PDF") >= 0, "[5] 真跑解析（字节入参）→ 回文本层：「" + String(p1.markdown).slice(0, 40) + "」");
  eq(p1.pages, 1, "[5] 页数 = 1");
  ok(Array.isArray(p1.formulas) && typeof p1.warning === "string", "[5] 成功形状带 formulas / warning（与 pdf:parse 同形）");
  const p2 = await fnPdfRead("read", { path: pdfPath });
  ok(p2.ok === true && p2.markdown === p1.markdown, "[5] 路径入参与字节入参同一条内核（结果一致）");
  const p3 = await fnPdfRead("info", { path: pdfPath });
  ok(p3.ok === true && p3.isPdf === true && p3.parseable === true && p3.pages === 1 && p3.encrypted === false, "[5] info：可解析 / 1 页 / 未加密（与 pdf:probe 同形）");

  const p4 = await fnPdfRead("read", { bytes: Buffer.from(ENC_PDF, "latin1") });
  ok(p4.ok === false && p4.error && p4.error.code === "encrypted", "[5] 加密 PDF → { ok:false, error:{ code:'encrypted' } }（不抛）");
  const p5 = await fnPdfRead("read", { path: txtPath });
  ok(p5.ok === false && p5.error && p5.error.code === "not_pdf", "[5] 非 PDF → code not_pdf");
  const p6 = await fnPdfRead("read", {});
  ok(p6.ok === false && p6.error && p6.error.code === "bad_source", "[5] 空入参 → code bad_source（消息点明需要路径或字节）");
  ok(/需要路径或字节/.test(String(p6.error && p6.error.message)), "[5] 空入参的报错文案说清要给什么（用户知道该填哪一格）");
  const p7 = await fnPdfRead("read", { path: path.join(tmpRoot, "nope.pdf") });
  ok(p7.ok === false && p7.error && p7.error.code === "not_found", "[5] 文件不存在 → code not_found");
  const p8 = await fnPdfRead("zzz", { bytes: miniBuf });
  ok(p8.ok === false && p8.error && p8.error.code === "bad_action", "[5] 未知动作 → code bad_action（点出动作名）");
  const p9 = await fnPdfRead("info", { path: txtPath });
  ok(p9.ok === true && p9.isPdf === false && p9.parseable === false && typeof p9.warning === "string", "[5] info 探非 PDF：ok:true + isPdf:false + warning（轻量探测不报错，只如实标）");
  const p10 = await fnPdfRead("info", { path: path.join(tmpRoot, "nope.pdf") });
  ok(p10.ok === false && p10.isPdf === false && typeof p10.warning === "string" && p10.error && p10.error.code === "not_found", "[5] info 载入失败：平铺字段（isPdf:false + warning）与 error 并存，不抛");

  eq(fs.readdirSync(tmpRoot).sort().join(","), before, "[5] 解析全程只读：临时目录没有多出任何文件（绝不落盘）");

  /* ═════════════════ [6] 工具库默认内置 + i18n + 白名单 ═════════════════ */
  console.log("\n[6] 工具库（默认内置）· i18n 中英成对 · 打包白名单");
  const handlers = new Map();
  const electronStub = {
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on() {},
      once() {},
      off() {},
      removeHandler() {},
      removeAllListeners() {},
    },
    ipcRenderer: { sendSync: () => undefined, send() {}, on() {}, invoke: () => Promise.resolve(), removeListener() {} },
    app: {},
    dialog: {},
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return electronStub;
    return origLoad.apply(this, arguments);
  };
  const { registerToolsIpc } = require(path.join(ROOT, "tools-store.js"));
  Module._load = origLoad;
  const dataDir = path.join(tmpRoot, "data");
  registerToolsIpc({ getDataDir: () => dataDir, t: (s) => String(s) });
  const call = (ch, arg) => Promise.resolve(handlers.get(ch)(null, arg));

  const list = await call("tools:list");
  ok(list.ok === true && Array.isArray(list.tools), "[6] tools:list 正常（内置 + 用户工具一份清单）");
  const bi = (list.tools || []).find((t) => t.id === "builtin:pdf-to-markdown");
  ok(!!bi, "[6] 内置条目进清单（id 带 builtin: 前缀）");
  ok(bi && bi.kind === "tool" && bi.builtin === true && bi.always === true, "[6] 清单口径：kind=tool · 内置 · 默认 always=true（会话不用翻开关）");
  eq(bi && bi.nodeCount, 2, "[6] 清单带 2 节点（壳 + 子节点），不改「轻量清单」口径");
  eq(bi && bi.wireCount, 4, "[6] 清单带 4 条内部线");
  ok(
    (list.tools || []).every((t) => !t.graph),
    "[6] 清单仍不带内部图（省带宽，插入 / 调用时才 tools:get）",
  );
  ok(
    (list.tools || []).some((t) => t.id === "builtin:desktop-capture" && t.always === false),
    "[6] 截图函数条目照旧 always=false（函数包不吃 always，只有工具条目吃）",
  );
  const got = await call("tools:get", "builtin:pdf-to-markdown");
  ok(got.ok === true && got.tool.graph.nodes.length === 2 && got.tool.graph.wires.length === 4, "[6] tools:get 取到全量包（插入画布 / 会话调用都走这条）");
  ok(got.tool.presets && got.tool.presets["PDF路径"], "[6] tools:get 带上参数预设（插入后点「测试」即有样例值）");
  /* 反向的那条内置工具：Markdown 转 PDF（Agent 可直接调用 → 生成 PDF 文件） */
  const biPdf = (list.tools || []).find((t) => t.id === "builtin:markdown-to-pdf");
  ok(!!biPdf, "[6] 内置条目 markdown-to-pdf 进清单（Agent 可调用）");
  ok(biPdf && biPdf.kind === "tool" && biPdf.builtin === true && biPdf.always === true, "[6] 清单口径：kind=tool · 内置 · 默认 always=true（会话不用翻开关）");
  eq(biPdf && biPdf.nodeCount, 2, "[6] 清单带 2 节点（壳 + 子节点）");
  eq(biPdf && biPdf.wireCount, 5, "[6] 清单带 5 条内部线（3 入 2 出）");
  const gotPdf = await call("tools:get", "builtin:markdown-to-pdf");
  ok(gotPdf.ok === true && gotPdf.tool.graph.nodes.length === 2 && gotPdf.tool.graph.wires.length === 5, "[6] tools:get 取到全量包（会话调用 / 插入画布同一份）");
  eq((gotPdf.tool.inputs || []).map((p) => p.name).join(","), "Markdown内容,源文件路径,输出路径", "[6] 全量包带上包级入参（Agent 参数 schema 由它生成）");
  ok(!!String((gotPdf.tool.presets || {})["输出路径"] || ""), "[6] 全量包带上输出路径预设");
  const off = await call("tools:patch", { id: "builtin:pdf-to-markdown", patch: { always: false } });
  ok(off.ok === true, "[6] 「会话随时可调用」开关可关");
  const list2 = await call("tools:list");
  ok(((list2.tools || []).find((t) => t.id === "builtin:pdf-to-markdown") || {}).always === false, "[6] 关掉后清单如实为 false（覆写生效）");
  ok(fs.existsSync(path.join(dataDir, "tools", "_builtin.json")), "[6] 覆写写进数据目录（不写回随包文件）");
  const back = await call("tools:patch", { id: "builtin:pdf-to-markdown", patch: { always: true } });
  const list3 = await call("tools:list");
  ok(back.ok === true && ((list3.tools || []).find((t) => t.id === "builtin:pdf-to-markdown") || {}).always === true, "[6] 再打开仍是 true（幂等覆写）");
  const rename = await call("tools:patch", { id: "builtin:pdf-to-markdown", patch: { name: "换个名字" } });
  ok(rename.ok === false && /不能改名/.test(rename.error), "[6] 内置条目改名被拒");
  const del = await call("tools:delete", "builtin:pdf-to-markdown");
  ok(del.ok === false && /不可删除/.test(del.error), "[6] 内置条目删除被拒");
  ok((await call("tools:get", "builtin:pdf-to-markdown")).ok === true, "[6] 被拒两次后条目仍在");

  /* ═════════════════ [7] 内置工具「Markdown 转 PDF」+ mtnode.writePdf ═════════════════ */
  console.log("\n[7] 内置工具 Markdown 转 PDF（工具壳 + 内部函数节点 + mtnode.writePdf 桥）");
  const mdEntry = (MANIFEST.tools || []).find((t) => t.key === "markdown-to-pdf");
  ok(!!mdEntry, "[7] preset-tools.json 有 markdown-to-pdf 内置条目（Agent 可调用的那条）");
  if (mdEntry) {
    eq(mdEntry.kind, "tool", "[7] 条目 kind = tool（工具条目才进 Agent 可调用清单）");
    eq(mdEntry.always, true, "[7] always = true：装上即可被会话直接调用（不必先插入画布）");
    ok(/Markdown/.test(mdEntry.name) && /PDF/.test(mdEntry.name), "[7] 条目名点明 Markdown → PDF：" + mdEntry.name);
    ok(/本机/.test(mdEntry.description) && /应用目录/.test(mdEntry.description), "[7] 描述写清只写本机指定路径、数据不落应用目录");
    eq((mdEntry.inputs || []).map((p) => p.name).join(","), "Markdown内容,源文件路径,输出路径", "[7] 包级入参：Markdown内容 / 源文件路径 / 输出路径");
    eq((mdEntry.outputs || []).map((p) => p.name).join(","), "文件路径,字节数", "[7] 包级出参：文件路径 / 字节数（回真实落盘路径，不吞结果）");
    ok(
      (mdEntry.inputs || []).concat(mdEntry.outputs || []).every((p) => p.kind === "text"),
      "[7] 五个端子全是文本（下游纯文本节点可直接接）",
    );

    const mdRoot = (mdEntry.graph.nodes || []).find((n) => n.id === mdEntry.graph.rootId);
    ok(!!mdRoot && mdRoot.kind === "super" && mdRoot.tool === true && mdRoot.db !== true, "[7] 根节点是「工具壳」：super + tool:true");
    const mdTc = (mdRoot && mdRoot.toolConfig) || {};
    eq(mdTc.name, mdEntry.name, "[7] 壳的 toolConfig.name 与条目名一致（Agent 调用按同一份取数）");
    eq((mdTc.inputs || []).map((p) => p.name).join(","), "Markdown内容,源文件路径,输出路径", "[7] 壳 toolConfig 输入表与包级一致");
    eq((mdTc.outputs || []).map((p) => p.name).join(","), "文件路径,字节数", "[7] 壳 toolConfig 输出表与包级一致");

    const mdFns = (mdEntry.graph.nodes || []).filter((n) => n.kind === "function");
    eq(mdFns.length, 1, "[7] 内部图恰好一个函数子节点（函数条目不吃 always，必须包成工具壳）");
    const mdFn = mdFns[0] || {};
    eq(mdFn.parentSuperId, mdRoot.id, "[7] 子节点 parentSuperId 指向壳（内侧线靠它归属）");
    eq((mdFn.inputs || []).map((p) => p.name).join(","), "Markdown内容,源文件路径,输出路径", "[7] 子节点参数表与壳一致");
    eq((mdFn.outputs || []).map((p) => p.name).join(","), "文件路径,字节数", "[7] 子节点输出表与壳一致");

    const MDJC = String(mdFn.jscode || "");
    ok(MDJC.indexOf("mtnode.writePdf") >= 0, "[7] jscode 走 mtnode.writePdf 落盘（不自己写第二套排版器）");
    ok(/typeof mtnode\.writePdf !== "function"/.test(MDJC), "[7] 先探测桥是否存在（老版本上给点名错误而不是 TypeError）");
    ok(MDJC.indexOf("mtnode.readText") >= 0, "[7] 正文留空时读「源文件路径」（.md / .txt 直接转）");
    ok(MDJC.indexOf("缺少输出路径") >= 0 && MDJC.indexOf("不是本机") < 0, "[7] 缺输出路径 → 明确报错（PDF 必须落盘，没有「只回文本」这条路）");
    ok(/没有正文/.test(String(mdEntry.presets && mdEntry.presets["Markdown内容"])) === false && /#/.test(String(mdEntry.presets["Markdown内容"])), "[7] 带参数预设（测试台点开就有能跑的样例正文与输出路径）");
    ok(!!String(mdEntry.presets["输出路径"] || ""), "[7] 预设里给了输出路径样例（.pdf）");

    const mdWires = mdEntry.graph.wires || [];
    eq(mdWires.length, 5, "[7] 内部图 5 条线（3 条内侧桥接 + 2 条内侧汇流）");
    const mdBridge = mdWires
      .filter((w) => w.from === mdRoot.id && w.to === mdFn.id)
      .sort((a, b) => a.fromIndex - b.fromIndex);
    eq(mdBridge.map((w) => w.fromIndex).join(","), "1,2,3", "[7] 内侧桥接：壳的参数端子号（1 / 2 / 3）");
    eq(mdBridge.map((w) => w.toIndex).join(","), "1,2,3", "[7] 桥接到子节点同名参数端子（1 / 2 / 3）");
    const mdFeed = mdWires
      .filter((w) => w.from === mdFn.id && w.to === mdRoot.id)
      .sort((a, b) => a.fromIndex - b.fromIndex);
    eq(mdFeed.map((w) => w.fromIndex).join(","), "0,1", "[7] 内侧汇流：子节点 2 个输出参数逐个回壳");
    eq(mdFeed.map((w) => w.toIndex).join(","), "0,1", "[7] 汇流落到壳的同号输出端子（0 / 1）");
    ok(mdWires.every((w) => !w.rel), "[7] 5 条都是数据线（rel 关系线不参与执行）");

    /* 引擎认得这 5 条线（复用 [2] 的 vm 切片与上下文） */
    const mdWf = {
      nodes: JSON.parse(JSON.stringify(mdEntry.graph.nodes)),
      wires: JSON.parse(JSON.stringify(mdEntry.graph.wires)),
    };
    sb.S.wf = mdWf;
    eq(G("superInternalBridgeWires", mdRoot, mdWf).length, 3, "[7] superInternalBridgeWires：3 条数据桥接被认出");
    eq(G("superInternalOutFeeds", mdRoot, mdWf).length, 2, "[7] superInternalOutFeeds：2 条内侧汇流被认出（文件路径 / 字节数回壳）");
    ok(G("isToolNode", mdRoot) === true, "[7] 壳被认成工具节点（端子序号钉死）");
    sb.S.wf = wf;

    /* jscode 真跑（假 mtnode 注入）：入参取值 / 落盘一次 / 错误分支 */
    const mdWrites = [];
    const mdReads = [];
    const mdLogs = [];
    const mdAbs = [];
    const fakeMdBridge = (extra) =>
      Object.assign(
        {
          log: (...a) => mdLogs.push(a.join(" ")),
          abs: (p) => {
            mdAbs.push(p);
            return "C:/out/" + String(p).replace(/^.*[\\/]/, "");
          },
          readText: (p) => {
            mdReads.push(p);
            return "# 来自文件\n\n正文";
          },
          writePdf: async (o) => {
            mdWrites.push(o);
            return { ok: true, path: o.outPath, bytes: 1234, ms: 12 };
          },
        },
        extra || {},
      );
    const runMd = (input, deps) => FNR.runUserFunction({ code: MDJC, input: input }, deps);
    const OUT_ARG = { 输出路径: "D:\\x\\报告.pdf" };
    {
      const r = await runMd({ ...OUT_ARG }, { mtnode: fakeMdBridge() });
      ok(r.ok === false && /没有正文/.test(String(r.error)), "[7] 不接正文也不给源文件 → 抛「没有正文」（点明两条路都给什么）");
      eq(mdWrites.length, 0, "[7] 没有正文时不碰 writePdf（不会拿空正文去排一次空 PDF）");
    }
    {
      const r = await runMd({ Markdown内容: "# 标题" }, { mtnode: fakeMdBridge() });
      ok(r.ok === false && /缺少输出路径/.test(String(r.error)), "[7] 缺输出路径 → 抛「缺少输出路径」");
    }
    {
      const r = await runMd({ Markdown内容: "# 标题\n正文", ...OUT_ARG }, { mtnode: fakeMdBridge() });
      ok(r.ok === true && r.value["文件路径"] === "C:/out/报告.pdf", "[7] 直接给正文 → 落盘并把真实路径回给端子");
      eq(mdWrites.length, 1, "[7] writePdf 恰好调一次（一次运行一份 PDF）");
      eq(mdWrites[0].text, "# 标题\n正文", "[7] 传给主进程的正文 = 入参原文（不改写用户内容）");
      eq(mdWrites[0].outPath, "C:/out/报告.pdf", "[7] 输出路径先过 mtnode.abs 归一（相对路径也能给）");
      eq(mdWrites[0].pageSize, "A4", "[7] 版面默认 A4");
      eq(mdWrites[0].pageNumbers, true, "[7] 默认带页码");
      eq(r.value["字节数"], "1234", "[7] 字节数如实回传（下游能判「真的写了东西」）");
      eq(Object.keys(r.value).sort().join(","), "字节数,文件路径", "[7] 返回形状就是这两个输出端子");
      ok(mdLogs.join("\n").indexOf("已生成 PDF") >= 0, "[7] 日志写明落盘结果（用户看得见）");
    }
    {
      mdReads.length = 0;
      mdWrites.length = 0;
      const r = await runMd({ Markdown内容: "", 源文件路径: "D:\\docs\\a.md", ...OUT_ARG }, { mtnode: fakeMdBridge() });
      ok(r.ok === true && mdReads.length === 1, "[7] 正文留空 + 给了源文件 → 读那份文件");
      eq(mdWrites[0].text, "# 来自文件\n\n正文", "[7] 落盘正文 = 文件内容");
      eq(mdWrites[0].baseDir, "D:\\docs", "[7] baseDir 取源文件所在目录（文件里的相对图片路径按它解析）");
    }
    {
      const r = await runMd({ Markdown内容: "# x", ...OUT_ARG }, { mtnode: { log: () => {} } });
      ok(r.ok === false && /不支持 PDF 生成/.test(String(r.error)), "[7] 桥不存在 → 点名「当前 MTNode 不支持 PDF 生成」");
    }
    {
      const r = await runMd(
        { Markdown内容: "# x", ...OUT_ARG },
        { mtnode: fakeMdBridge({ writePdf: async () => ({ ok: false, error: "拒绝写入应用目录" }) }) },
      );
      ok(r.ok === false && /生成 PDF 失败/.test(String(r.error)) && /应用目录/.test(String(r.error)), "[7] 主进程拒绝（应用目录）→ 抛「生成 PDF 失败：…」并带上原因");
    }
    {
      mdReads.length = 0;
      const r = await runMd(
        { Markdown内容: "", 源文件路径: "D:\\docs\\none.md", ...OUT_ARG },
        {
          mtnode: fakeMdBridge({
            readText: () => {
              throw new Error("ENOENT: no such file");
            },
          }),
        },
      );
      ok(r.ok === false && /读不到/.test(String(r.error)) && /ENOENT/.test(String(r.error)), "[7] 源文件读不到 → 点名路径与原因（不静默生成空 PDF）");
    }
  }

  /* mtnode.writePdf 桥：入参归一 + dispatchProc 分支 + 真 worker 三跑 */
  ok(
    /writePdf: \(a, b\) => call\("writePdf", pdfWriteArg\(a, b\)\)/.test(FNRT),
    "[7] mtnode 桥暴露 writePdf（经 pdfWriteArg 归一后 call 出去）",
  );
  ok(
    /action === "writePdf"/.test(FNRT) && /deps\.pdfWrite/.test(FNRT) && /PDF 写出后端未接线/.test(FNRT),
    "[7] dispatchProc 有 writePdf 分支，没接线时给点名错误（不抛）",
  );
  const writeLog = [];
  const wbridge = FNR.buildMtnodeBridge({
    call: async (action, payload) => {
      writeLog.push({ action, payload });
      return { ok: true, path: "C:/out/a.pdf", bytes: 9 };
    },
  });
  ok(typeof wbridge.writePdf === "function", "[7] buildMtnodeBridge 产出 writePdf");
  await wbridge.writePdf("C:/out/a.pdf", "# 标题");
  eq(writeLog[0].action, "writePdf", "[7] writePdf(路径, 正文) → action writePdf");
  eq(writeLog[0].payload.outPath, "C:/out/a.pdf", "[7] 纯字符串两参：第一参 = 输出路径（照 writeText 的读法）");
  eq(writeLog[0].payload.text, "# 标题", "[7] 纯字符串两参：第二参 = 正文");
  await wbridge.writePdf({ text: "# x", outPath: "C:/out/b.pdf", pageSize: "A3" });
  eq(writeLog[1].payload.pageSize, "A3", "[7] 对象写法原样透传（版面项不被吞）");

  const rtNoW = FNR.createFnRuntime({ procHost: PROC_HOST });
  const rNoW = await rtNoW.run({
    runId: "pdf-smoke-write-nowire",
    code: 'const r = await mtnode.writePdf({ text: "# x", outPath: "C:/out/a.pdf" }); return r.error;',
    input: {},
  });
  ok(
    rNoW.ok === true && /PDF 写出后端未接线/.test(String(rNoW.value)) && /pdfWrite/.test(String(rNoW.value)),
    "[7] 真跑：未接线时 mtnode.writePdf 回点名错误 · got " + JSON.stringify(rNoW.value),
  );
  const rMissPath = await rtNoW.run({
    runId: "pdf-smoke-write-nopath",
    code: 'const r = await mtnode.writePdf({ text: "# x" }); return r.error;',
    input: {},
  });
  ok(rMissPath.ok === true && /PDF 写出后端未接线/.test(String(rMissPath.value)), "[7] 真跑：没接后端时先回「未接线」点名错误（不让用户去猜是不是自己的路径写错了）");
  const rMissText = await rtNoW.run({
    runId: "pdf-smoke-write-notext",
    code: 'const r = await mtnode.writePdf({ outPath: "C:/out/a.pdf", text: "  " }); return r.error;',
    input: {},
  });
  ok(rMissText.ok === true && /PDF 写出后端未接线/.test(String(rMissText.value)), "[7] 真跑：同样回「未接线」；注入后端后这两条入参校验才生效（见下）");
  /* 注入了后端时，桥自己的入参闸门才看得见 */
  const gateSeen = [];
  const rtGate = FNR.createFnRuntime({
    procHost: PROC_HOST,
    pdfWrite: async (params) => {
      gateSeen.push(params);
      return { ok: true, path: params.outPath, bytes: 1 };
    },
  });
  const g1 = await rtGate.run({
    runId: "pdf-smoke-write-gate1",
    code: 'const r = await mtnode.writePdf({ text: "# x" }); return r.error;',
    input: {},
  });
  ok(g1.ok === true && /缺少输出路径/.test(String(g1.value)), "[7] 真跑：没给 outPath 被桥挡下（不进主进程）");
  const g2 = await rtGate.run({
    runId: "pdf-smoke-write-gate2",
    code: 'const r = await mtnode.writePdf({ outPath: "C:/out/a.pdf", text: "  " }); return r.error;',
    input: {},
  });
  ok(g2.ok === true && /没有可生成 PDF 的文本输入/.test(String(g2.value)), "[7] 真跑：空正文同样被挡下（不排一张空白 PDF）");
  eq(gateSeen.length, 0, "[7] 两条被挡的调用一次都没到后端（浪费的排版窗口 0 个）");

  const seenW = [];
  const rtYesW = FNR.createFnRuntime({
    procHost: PROC_HOST,
    pdfWrite: async (params) => {
      seenW.push(params);
      return { ok: true, path: params.outPath, bytes: 42, ms: 7 };
    },
  });
  const rYesW = await rtYesW.run({
    runId: "pdf-smoke-write-wired",
    code:
      'const r = await mtnode.writePdf("C:/out/c.pdf", "# 正文");' +
      "return { p: r.path, b: r.bytes };",
    input: {},
  });
  ok(rYesW.ok === true && rYesW.value.p === "C:/out/c.pdf" && rYesW.value.b === 42, "[7] 真跑：注入 pdfWrite 后 writePdf 能拿到后端结果");
  eq(seenW.length, 1, "[7] 后端被调用 1 次");
  eq(seenW[0].outPath, "C:/out/c.pdf", "[7] 输出路径一路透传到后端");
  eq(seenW[0].text, "# 正文", "[7] 正文一路透传到后端");
  ok(PROC_HOST.activeProcessCount() === 0, "[7] 运行结束后宿主登记表为空（无残留进程）");

  /* 函数节点桥的这一支必须是「借主进程内核」，不能自己写第二套排版器 */
  const FNPDFW = fnBody(MAIN, "fnPdfWrite");
  ok(/pdfWrite: \(params\) => fnPdfWrite\(params\)/.test(MAIN), "[7] main.js 给 fnRuntime 注入 pdfWrite → fnPdfWrite");
  ok(FNPDFW.indexOf("pdfWrite.writeTextPdf(") >= 0, "[7] fnPdfWrite 只调 pdf-write.js 的 writeTextPdf 内核");
  ok(
    FNPDFW.indexOf("printToPDF") < 0 && FNPDFW.indexOf("BrowserWindow") < 0 && FNPDFW.indexOf("require(") < 0,
    "[7] 绝不另写排版器（建打印窗 / printToPDF 一律不在这份桥里）",
  );
  eq((MAIN.match(/writeTextPdf\(/g) || []).length, 2, "[7] writeTextPdf 全仓调用点只有 2 处（pdf:writeText 通道 + 函数节点桥，同一份内核）");

  const I18n = require(path.join(ROOT, "renderer", "i18n.js"));
  const KEYS = [
    "PDF 解析后端未接线（主进程未注入 fnRuntime.pdfConvert）：mtnode.readPdf 暂不可用",
    "PDF 写出后端未接线（主进程未注入 fnRuntime.pdfWrite）：mtnode.writePdf 暂不可用",
    "未知的 PDF 解析动作：",
    "mtnode 桥未接线（缺少 call）",
    "mtnode.ai：函数节点的 AI 调用后端未接线（主进程未注入 fnRuntime.aiCall）",
    "未知的 mtnode 桥调用：",
    "(空)",
  ];
  I18n.setLocale("zh");
  ok(KEYS.every((k) => I18n.t(k) === k), "[6] 中文界面逐条原样回显（7 条桥报错词条）");
  I18n.setLocale("en");
  const untranslated = KEYS.filter((k) => I18n.t(k) === k || !/[A-Za-z]{4,}/.test(I18n.t(k)));
  ok(untranslated.length === 0, "[6] 英文界面 7 条全有译文（成对）" + (untranslated.length ? " · 缺：" + untranslated.join(" / ") : ""));
  I18n.setLocale("zh");

  /* build.json 是 JSONC（含块注释与尾逗号），按「带引号的条目原文」查白名单 */
  const BUILD = read("build.json");
  const inBuild = (p) => BUILD.indexOf('"' + p + '"') >= 0;
  ok(inBuild("renderer/**"), "[6] build.json 带 renderer/**（preset-tools.json 随包发版，白名单无需新增）");
  const missing = ["fn-runtime.js", "tools-store.js", "pdf-doc.js", "pdf-math.js", "pdf-write.js"].filter((f) => !inBuild(f));
  ok(missing.length === 0, "[6] PDF 相关主进程模块都在白名单里" + (missing.length ? " · 缺：" + missing.join(",") : ""));
  ok(
    !/require\(/.test(FNPDF) && !/require\(/.test(MAIN.slice(KERNEL_START, KERNEL_END)),
    "[6] 本次改动没 require 任何新根模块 → 打包白名单无需新增（复用的都是已随包文件）",
  );

  /* ── 汇总 ── */
  console.log(
    "\n" + (fails ? "FAILED " : "PASS ") + (checks - fails) + "/" + checks + " 项通过" + (fails ? "（失败 " + fails + "）" : ""),
  );
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  process.exitCode = fails ? 1 : 0;
})();
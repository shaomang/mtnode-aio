/* test/smoke-pdf.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-pdf.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-pdf-tool.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-pdf-tool.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  })();
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-pdf-tool.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-pdf-tool.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-pdf-math-review.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-pdf-math-review.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) =>
    fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
  const has = (s, sub) => String(s).indexOf(sub) >= 0;

  /* ═══════════ [1] PDF 分类与 IPC 存在 ═══════════ */

  console.log("[1] PDF 分类与 IPC 存在");
  {
    const main = read("main.js");
    ok(/ipcMain\.handle\(\s*["']pdf:probe["']/.test(main), "main.js 注册 pdf:probe IPC");
    ok(/ipcMain\.handle\(\s*["']pdf:parse["']/.test(main), "main.js 注册 pdf:parse IPC");
    ok(/%PDF-\\d\\\.\\d/.test(main), "main.js 以 %PDF-x.y 文件头做 PDF 分类");
    ok(
      /isPdf:\s*false/.test(main) && /code:\s*"not_pdf"/.test(main),
      "非 PDF 归类：probe=isPdf:false / parse=not_pdf",
    );

    const pre = read("preload.js");
    ok(
      /filePdfInfo:\s*\(arg\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]pdf:probe['"]/.test(pre),
      "preload 暴露 filePdfInfo → pdf:probe",
    );
    ok(
      /fileParsePdf:\s*\(arg\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]pdf:parse['"]/.test(pre),
      "preload 暴露 fileParsePdf → pdf:parse",
    );

    const app = read("renderer/app.js");
    ok(/avi\|pdf\)\$\/i/.test(app), "会话正文链接分类认得 .pdf 扩展名");

    let doc = null;
    try {
      doc = require(path.join(ROOT, "pdf-doc.js"));
    } catch (_) {
      doc = null;
    }
    ok(
      !!doc &&
        typeof doc.pdfToMarkdown === "function" &&
        typeof doc.extractPages === "function" &&
        typeof doc.parsePdfStructure === "function",
      "pdf-doc.js 可加载且导出 pdfToMarkdown / extractPages / parsePdfStructure",
    );

    /* 最小合法 PDF（无 xref，走全文件扫描兜底）→ 分类为 PDF 1.4 / 1 页 / 612×792 */
    const mini = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
      "trailer << /Root 1 0 R /Size 4 >>",
      "%%EOF",
      "",
    ].join("\n");
    let st = null;
    try {
      st = doc ? doc.parsePdfStructure(Buffer.from(mini, "latin1")) : null;
    } catch (_) {
      st = null;
    }
    ok(!!st && st.version === "1.4", "最小 PDF 被分类为 PDF 1.4");
    ok(!!st && st.pages === 1, "页数识别为 1");
    ok(
      !!st &&
        st.pageSizes &&
        st.pageSizes[0] &&
        st.pageSizes[0].width === 612 &&
        st.pageSizes[0].height === 792,
      "页面尺寸识别为 612×792",
    );
  }

  /* ═══════════ [2] 公式 LaTeX 还原（pdf-math.js） ═══════════ */

  console.log("\n[2] 公式 LaTeX 还原（pdf-math.js）");
  {
    let pm = null;
    try {
      pm = require(path.join(ROOT, "pdf-math.js"));
    } catch (_) {
      pm = null;
    }
    ok(!!pm && typeof pm.restoreMath === "function", "pdf-math.js 可加载并导出 restoreMath");
    if (pm) {
      ok(pm.isMathFont("Cambria Math") === true, "数学字体识别：Cambria Math → 数学");
      ok(pm.isMathFont("Arial") === false, "正文字体识别：Arial → 非数学");

      const u = pm.unicodeToLatex("α+β≤γ");
      ok(
        has(u, "\\alpha") && has(u, "\\beta") && has(u, "\\le") && has(u, "\\gamma"),
        "Unicode 数学符号 → LaTeX 命令",
      );
      ok(has(pm.unicodeToLatex("x²"), "^{2}"), "上标 Unicode ² → ^{2}");

      const sup = pm.restoreMath([
        { text: "x", font: "Cambria Math", size: 12, x: 0, y: 0 },
        { text: "2", font: "Cambria Math", size: 8, x: 8, y: -5 },
      ]);
      ok(has(sup, "^{2}") && has(sup, "x"), "run 几何还原出上标 x^{2}");
      ok(/\$[^$]*x\^\{2\}/.test(sup), "上标公式被 $…$ 包起来");

      const frac = pm.restoreMath([
        { text: "1", font: "Cambria Math", size: 12, x: 0, y: 0 },
        { text: "−", font: "Cambria Math", size: 12, x: 2, y: 7 },
        { text: "2", font: "Cambria Math", size: 12, x: 2, y: 14 },
      ]);
      ok(has(frac, "\\frac{1}{2}"), "版面分式还原为 \\frac{1}{2}");

      const greek = pm.restoreMath([
        { text: "α", font: "Cambria Math", size: 12, x: 0, y: 0 },
        { text: "=", font: "Cambria Math", size: 12, x: 8, y: 0 },
        { text: "β", font: "Cambria Math", size: 12, x: 16, y: 0 },
      ]);
      ok(has(greek, "\\alpha") && has(greek, "\\beta"), "希腊字母 run 还原为 \\alpha / \\beta");

      const tx = pm.restoreMath("面积为 πr²");
      ok(
        /\$[^$]*\\pi r\^\{2\}\$/.test(tx),
        "纯文本兜底把 πr² 包成 $\\pi r^{2}$（不误吞中文）",
      );
      ok(has(tx, "面积为"), "公式区间外的正文原样保留");
    }
  }

  /* ═══════════ [3] 公式渲染子集（renderer/math-render.js） ═══════════ */

  console.log("\n[3] 公式渲染子集（renderer/math-render.js）");
  {
    let M = null;
    try {
      M = require(path.join(ROOT, "renderer", "math-render.js"));
    } catch (_) {
      M = null;
    }
    ok(!!M && typeof M.latexToHtml === "function", "math-render.js 可加载并导出 latexToHtml");
    ok(
      !!M && typeof M.mdToHtml === "function" && typeof M.splitMath === "function",
      "导出 mdToHtml / splitMath",
    );
    ok(
      !!M && has(fs.readFileSync(path.join(ROOT, "renderer", "math-render.js"), "utf8"), "MTMathRender"),
      "以 window.MTMathRender 暴露给渲染层",
    );

    if (M) {
      const html = (t, o) => M.latexToHtml(t, o);

      const sup = html("x^2");
      ok(has(sup, 'class="rv-msup"') && has(sup, ">2<"), "上标 x^2 → .rv-msup");
      ok(has(html("a_{i}"), 'class="rv-msub"'), "下标 a_{i} → .rv-msub");
      ok(has(html("x^2+y^2"), 'class="rv-msup"'), "连写公式多处上下标");

      const frac = html("\\frac{a}{b}");
      ok(has(frac, 'class="rv-mnum"') && has(frac, 'class="rv-mden"'), "分式 → 分子 / 分母");

      const sqrt = html("\\sqrt[3]{x+1}");
      ok(has(sqrt, 'class="rv-msqrt-body"') && has(sqrt, 'class="rv-msqrt-idx"'), "根号 \\sqrt[n]{}");

      const greek = html("\\alpha+\\beta");
      ok(has(greek, "α") && has(greek, "β"), "希腊字母 → 字符");

      const ops = html("a\\times b\\le c");
      ok(has(ops, "×") && has(ops, "≤"), "常用算子 / 关系符 → 符号");
      ok(has(html("\\sum_{i=1}^{n}"), "∑"), "大算符 \\sum → ∑");

      const mat = html("\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}");
      ok(has(mat, 'class="rv-mtable"'), "矩阵 → .rv-mtable");
      ok((mat.match(/rv-mrow/g) || []).length === 2, "矩阵 2 行");
      ok((mat.match(/rv-mcell/g) || []).length === 4, "矩阵 2×2 = 4 格");
      ok(has(mat, 'class="rv-mdelim rv-mdelim-big">('), "pmatrix 带圆括号定界符");

      const cases = html("\\begin{cases}x & x>0 \\\\ 0 & x\\le 0\\end{cases}");
      ok(has(cases, "rv-mcases"), "cases 环境");

      ok(has(html("\\text{速度}"), 'class="rv-mtext"'), "\\text{} 直立排版");
      ok(has(html("\\mathbb{R}"), "ℝ"), "\\mathbb{R} → ℝ");

      ok(has(html("\\foo{x}"), "\\foo"), "未知命令原样显示（不崩、不丢）");

      ok(has(sup, 'data-rv-tex="x^2"'), "原始 LaTeX 存在 data-rv-tex（序列化可还原）");
      ok(has(sup, 'data-rv-display="0"'), "行内公式标记 display=0");
      ok(has(html("\\frac{a}{b}", { display: true }), 'data-rv-display="1"'), "显示公式标记 display=1");
      ok(has(html("x", { display: true }), "rv-math-display"), "显示公式带 .rv-math-display");

      /* `$…$` 抽取：代码块 / 行内码里的 $ 不算公式 */
      const sp = M.splitMath(
        "公式 $x^2$ 与\n\n$$\\frac{1}{2}$$\n\n`$no$`\n\n```\n$no$\n```",
      );
      ok(sp.items.length === 2, "只抽出 2 个公式（代码块 / 行内码的 $ 不动）");
      ok(sp.items[0].tex === "x^2" && sp.items[0].display === false, "行内公式 tex 原样保留");
      ok(
        sp.items[1].tex === "\\frac{1}{2}" && sp.items[1].display === true,
        "显示公式（跨行 $$）tex 原样保留",
      );
      ok(has(sp.md, "`$no$`") && has(sp.md, "$no$"), "代码块与行内码原样保留");

      /* 金额不被误判：行内 $ 必须紧贴内容（通行口径），$100 … $200 保持原文 */
      const cur = M.splitMath("价格 $100 到 $200 元");
      ok(cur.items.length === 0, "金额 $100 … $200 不被误判成公式");
      ok(has(cur.md, "$100") && has(cur.md, "$200"), "金额原文原样保留");

      /* AI 产出 / PDF 转 Markdown 常用的 `\(…\)` `\[…\]` 同样抽出（此前只认 $ 两式） */
      const br = M.splitMath("行内 \\(x^2\\)\n\n\\[\n\\frac{a}{b}\n\\]");
      ok(br.items.length === 2, "`\\(…\\)` 与跨行 `\\[…\\]` 都抽出");
      ok(br.items[0].display === false && br.items[0].delim === "\\(", "行内 `\\(…\\)` 记 delim");
      ok(br.items[1].display === true && br.items[1].delim === "\\[", "显示式 `\\[…\\]` 记 delim");
      const brHtml = M.latexToHtml(br.items[1].tex, { display: true, delim: "\\[" });
      ok(has(brHtml, 'data-rv-delim="\\["'), "渲染根节点带原定界符（回写不改写用户源码）");
      ok(
        M.splitMath("`\\(x\\)`").items.length === 0,
        "行内码里的 `\\(…\\)` 不当公式",
      );

      /* 内侧留白的 `$ … $` 仍认公式（带汉字 / 纯金额的片段继续判否） */
      const pad = M.splitMath("$ x^2 $");
      ok(pad.items.length === 1 && pad.items[0].tex === "x^2", "$ x^2 $ 内侧留白仍渲染");
      ok(M.splitMath("$ a+b $").items.length === 1, "$ a+b $ 内侧留白仍渲染");
      ok(
        M.splitMath("价格 $100 到 $200 元").items.length === 0,
        "留白规则放宽后金额仍不误判（含汉字的片段判否）",
      );

      /* 数学画布「综述」等真实文档用到的写法：此前不认识 → 原样显示成 \asymp 这类源码，
         公式看着就像「没渲染」。这一组钉住它们都出排版结果、且没有 rv-mcmd 残留。 */
      const noCmd = (src) => !/rv-mcmd/.test(html(src));
      const asymp = html("\\asymp_q x^q");
      ok(has(asymp, "≍") && noCmd("\\asymp_q x^q"), "\\asymp → ≍（数论文档高频，此前漏成源码）");
      ok(has(html("a\\coloneqq b"), "≔"), "\\coloneqq → ≔");
      ok(has(html("a\\lesssim b"), "≲"), "\\lesssim → ≲");
      ok(
        has(html("\\overline{f(m)}"), "rv-mover") && noCmd("\\overline{f(m)}"),
        "\\overline{} 画上划线（此前漏成 \\overline 字面量）",
      );
      ok(has(html("\\underline{x}"), "rv-munder"), "\\underline{} 画下划线");
      ok(
        has(html("\\tilde{\\mathbb P}(A)"), "rv-macc") &&
          has(html("\\hat{x}"), "rv-macc") &&
          has(html("\\bar{a}"), "rv-macc") &&
          has(html("\\vec{v}"), "rv-macc"),
        "\\tilde / \\hat / \\bar / \\vec 走重音层（.rv-macc）",
      );
      ok(
        has(html("a\\xrightarrow{p}b"), "rv-marrow") && noCmd("a\\xrightarrow{p}b"),
        "\\xrightarrow{p} 带标注箭头（此前漏成源码）",
      );
      /* \substack 是大算符下标里的多行限界：整篇文档里出现上百次，必须真正堆叠 */
      const subst = html("\\sum_{\\substack{n=1\\\\P(n)\\leq x}}f(n)");
      ok(
        has(subst, "rv-mstack") && (subst.match(/rv-mstack-r/g) || []).length === 2 && noCmd("\\sum_{\\substack{n=1\\\\P(n)\\leq x}}f(n)"),
        "\\substack{a\\\\b} 两行堆叠（大算符下标）",
      );
      ok(has(html("x\\tag{4.1}"), "rv-mtag"), "\\tag{4.1} 公式编号右浮动，不混进公式主体");
      ok(
        has(html("\\Big|\\sum a_n\\Big|"), "rv-mdelim-big") &&
          has(html("\\big( x \\big)"), "rv-mdelim-big"),
        "\\big / \\Big 放大的定界符",
      );
      ok(
        has(html("\\operatorname{Li}(x)"), "rv-mtext") &&
          has(html("a\\bmod p"), ">mod<") &&
          has(html("a\\pmod{p}"), "(mod p)") &&
          noCmd("\\operatorname{Li}(x)"),
        "\\operatorname{} / \\bmod / \\pmod{} 直立排版（不印命令名）",
      );
      ok(has(html("\\|x\\|"), "‖"), "\\| 转义为 ‖（范数，此前反斜杠被吞、竖线当定界符）");
      ok(has(html("\\binom{n}{k}"), "rv-mbinom"), "\\binom{n}{k} 二项式系数");
      ok(
        noCmd("\\bigcup_{n}A_n") && noCmd("x\\dots y") && noCmd("\\sum\\limits_{i}"),
        "\\big 前缀不误伤 \\bigcup / \\dots / \\limits",
      );

      /* 逐条钉住整份「综述」原文里的 LaTeX 命令都被认识（真实语料回归：
         此前残留 \asymp ×10 / \overline / \xrightarrow / \substack，公式看着像没渲染） */
      const realCorpus = [
        "\\mathbb{E}\\left|\\sum_{n\\leq x}f(n)\\right|^{2q},\\qquad q\\geq 0,",
        "\\mathbb{E}f(n)\\overline{f(m)}=\\mathbf{1}_{n=m}|f(n)|^2.",
        "\\mathbb{E}\\left|\\sum_{n\\leq x}f(n)\\right|^{2q}\\asymp\\left(\\frac{x}{1+(1-q)\\sqrt{\\log\\log x}}\\right)^{q}.",
        "\\frac{\\sum_{n\\leq x}f(n)}{\\sqrt{\\mathbb{E}|\\sum_{n\\leq x}f(n)|^2}}\\xrightarrow{p}0.",
        "F(s)=\\prod_{p\\leq x}\\left(1-\\frac{f(p)}{p^s}\\right)^{-1}=\\sum_{\\substack{n=1\\\\P(n)\\leq x}}^{\\infty}\\frac{f(n)}{n^s}.",
        "\\mathbb{P}\\left(\\left|\\sum_{n\\leq x}f(n)\\right|\\geq \\lambda\\frac{\\sqrt{x}}{(\\log\\log x)^{1/4}}\\right)\\ll\\frac{\\min\\{\\log\\lambda,\\sqrt{\\log\\log x}\\}}{\\lambda^2}.",
        "e^{-q^2\\log q-q^2\\log\\log(2q)+O(q^2)}\\,x^q\\,\\log^{(q-1)^2}x.\\tag{4.1}",
        "\\tilde{\\mathbb P}(A):=\\frac{\\mathbb E\\mathbf 1_A\\prod_{p\\leq x^{1/e}}a_p}{\\log x}",
      ];
      let corpusBad = [];
      realCorpus.forEach((src) => {
        const outHtml = html(src);
        const ms = outHtml.match(/class="rv-mcmd">([^<]*)</g) || [];
        if (ms.length) corpusBad.push(src.slice(0, 40) + " → " + ms.join(","));
      });
      ok(corpusBad.length === 0, "「综述」真实公式逐条无未识别命令（残留：" + corpusBad.join(" | ") + "）");
      ok(
        M.splitMath(realCorpus.map((s) => "$" + s + "$").join("\n\n")).items.length ===
          realCorpus.length,
        "「综述」真实公式全部被抽成公式项（行内 / 显示式定界符都认出）",
      );

      /* mdToHtml：占位符替换 → 无残留，公式已渲染 */
      const stub = (md) => "<p>" + md + "</p>";
      const out = M.mdToHtml("公式 $\\alpha$ 结束", stub);
      ok(has(out, 'data-rv-tex="\\alpha"') && has(out, "α"), "mdToHtml 渲染行内公式");
      ok(!M.TOKEN_RE.test(out), "占位符已全部替换（无 PUA 残留）");
      M.TOKEN_RE.lastIndex = 0;

      let realMarked = null;
      try {
        const mk = require("marked");
        realMarked = (mk && mk.parse) || (mk && mk.marked && mk.marked.parse) || null;
      } catch (_) {}
      if (realMarked) {
        const real = M.mdToHtml(
          "公式 $\\alpha$ 与\n\n$$\\frac{1}{2}$$\n\n`$no$`",
          (md) => realMarked(md, { gfm: true, breaks: true }),
        );
        ok(has(real, 'data-rv-tex="\\alpha"') && has(real, "α"), "与真实 marked 串联：行内公式渲染");
        ok(has(real, 'data-rv-display="1"'), "与真实 marked 串联：显示公式渲染");
        ok(has(real, "$no$"), "与真实 marked 串联：行内码里的 $ 不动");
      }

      const attrs = M.texAttrsOf({
        getAttribute: (k) =>
          k === "data-rv-tex" ? "x^2" : k === "data-rv-display" ? "1" : null,
      });
      ok(
        !!attrs && attrs.tex === "x^2" && attrs.display === true,
        "texAttrsOf 读回原始 LaTeX / 显示式标记",
      );
    }
  }

  /* ═══════════ [4] 审阅回归（含公式往返） ═══════════ */

  console.log("\n[4] 审阅回归（同源渲染 + 公式往返不破坏）");
  {
    const src = read("renderer/app-review.js");
    const markedHits = src.match(/marked\.parse\s*\(/g) || [];
    ok(markedHits.length === 1, "Markdown 只在一处解析（marked.parse 调用唯一）");
    ok(
      /function markedPreviewHtml\(raw\)\s*\{[\s\S]{0,200}rvMarkdownHtml\(raw\)/.test(src),
      "markedPreviewHtml 与富文本同源（rvMarkdownHtml）",
    );
    ok(
      /function mdToRichHtml\(raw\)\s*\{[\s\S]{0,200}rvMarkdownHtml\(raw\)/.test(src),
      "mdToRichHtml 与只读预览同源（rvMarkdownHtml）",
    );
    ok(
      /MTMathRender[\s\S]{0,120}mdToHtml/.test(src),
      "rvMarkdownHtml 走 window.MTMathRender.mdToHtml",
    );
    ok(
      /data-rv-tex/.test(src) && /rvMathElOf/.test(src) && /pushMathMd/.test(src),
      "序列化按 data-rv-tex 还原 LaTeX（inlineToMd / walkBlocks）",
    );
    ok(
      /data-rv-delim/.test(src) && /rvMathMdOf/.test(src),
      "序列化按 data-rv-delim 还原原定界符（$ / $$ / \\( / \\[ 不被改写）",
    );
    ok(/buildRevisionPrompt\(v\.text/.test(src), "「让 AI 依据批注修订」取当前版 Markdown 源码");
    ok(
      /case "mathInline"[\s\S]*?case "mathDisplay"/.test(src) && /reviewMathDialog/.test(src),
      "工具栏 $ / $$ 录入入口与对话框存在",
    );

    /* 样式 + i18n + 加载顺序 */
    const css = read("renderer/css/review.css");
    ok(
      has(css, ".rv-math-display") && has(css, ".rv-mfrac") && has(css, ".rv-mtable"),
      "review.css 补了公式排版样式",
    );
    const i18n = read("renderer/i18n.js");
    const keys = ["行内公式", "显示公式", "插入行内公式", "插入显示公式", "公式（LaTeX）", "插入公式", "公式已插入"];
    let i18nOk = true;
    for (const k of keys) if (!has(i18n, '"' + k + '"')) i18nOk = false;
    ok(i18nOk, "i18n 中英词条齐备（$ / $$ 录入相关）");
    ok(
      /"插入显示公式":\s*"Insert display formula"/.test(i18n),
      "i18n 英文同步（示例：插入显示公式）",
    );
    const html = read("renderer/index.html");
    const atMath = html.indexOf('src="math-render.js"');
    const atReview = html.indexOf('src="app-review.js"');
    ok(atMath >= 0 && atReview >= 0 && atMath < atReview, "index.html 先加载 math-render.js 再 app-review.js");

    /* 既有审阅修订回归（skipCommit 口径）仍在 */
    const regPath = path.join(ROOT, "test", "smoke-review-revise.js");
    ok(fs.existsSync(regPath), "既有 smoke-review-revise.js 仍在");
    ok(has(read("test/smoke-review-revise.js"), "skipCommit"), "既有修订回归口径（skipCommit）未变");

    /* ── 真跑：app-review.js 在沙箱里序列化公式 / 组装修订提示词 ── */
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.console = console;
    sandbox.I18n = { t: (s) => String(s) };
    sandbox.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.document = {
      getElementById: () => null,
      createElement: () => ({
        style: {},
        appendChild() {},
        classList: { add() {}, remove() {}, toggle() {} },
      }),
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "app-review.js" });

    const mEl = (tag, attrs, children) => {
      const el = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        childNodes: children || [],
        getAttribute: (k) =>
          Object.prototype.hasOwnProperty.call(attrs || {}, k) ? attrs[k] : null,
      };
      return el;
    };
    const mText = (s) => ({ nodeType: 3, textContent: String(s) });
    const mMath = (tex, display) =>
      mEl("span", { "data-rv-tex": tex, "data-rv-display": display ? "1" : "0" });

    const root = { nodeType: 1, tagName: "DIV" };
    root.childNodes = [mEl("p", null, [mMath("\\frac{a}{b}", true)])];
    const blockMd = vm.runInContext("richToMarkdown", sandbox)(root);
    ok(blockMd === "$$\n\\frac{a}{b}\n$$\n", "显示公式序列化回独立 $$…$$ 块");

    const root2 = { nodeType: 1, tagName: "DIV" };
    root2.childNodes = [
      mEl("p", null, [mText("公式 "), mMath("x^2", false), mText(" 结束")]),
    ];
    const inlineMd = vm.runInContext("richToMarkdown", sandbox)(root2);
    ok(inlineMd === "公式 $x^2$ 结束\n", "行内公式序列化回 $…$（前后正文不串）");

    const prompt = vm.runInContext("buildRevisionPrompt", sandbox)(
      "正文 $x^2$ 与 $$\\frac{a}{b}$$ 结束",
      [{ kind: "full", body: "公式下标写错，改一下" }],
    );
    ok(
      has(prompt, "$x^2$") && has(prompt, "$$\\frac{a}{b}$$"),
      "修订提示词里的公式源码原样保留（AI 取文不破坏公式）",
    );
    ok(has(prompt, "公式下标写错，改一下"), "批注正文同时进提示词");
  }

  /* ═══════════ [5] 全站 Markdown 预览（app.js renderMarkdown）支持公式 ═══════════ */

  console.log("\n[5] 全站 Markdown 预览支持公式（renderer/app.js renderMarkdown）");
  {
    const appjs = read("renderer/app.js");
    const rmMatch = /function renderMarkdown\(text\)[\s\S]*?\r?\n}\r?\n/.exec(appjs);
    const rmSrc = rmMatch ? rmMatch[0] : "";
    ok(rmSrc.length > 0, "app.js 找到 renderMarkdown");
    ok(
      /window\.MTMathRender/.test(rmSrc) && /splitMath/.test(rmSrc) && /latexToHtml/.test(rmSrc),
      "renderMarkdown 接入 MTMathRender（splitMath 抽取 + latexToHtml 渲染）",
    );
    ok(
      /breaks: true/.test(rmSrc) && /escapeHtml\(text\)/.test(rmSrc),
      "仍保留「先转义再解析」与 breaks:true（聊天口径未被这次改动带偏）",
    );
    ok(
      /html\.replace\(\s*M\.TOKEN_RE/.test(rmSrc),
      "占位符替换回公式（无 PUA 残留）",
    );

    /* 真跑：把 renderMarkdown 原样放进沙箱，接真实的 marked + math-render.js */
    let M = null;
    try {
      M = require(path.join(ROOT, "renderer", "math-render.js"));
    } catch (_) {}
    let realMarked = null;
    try {
      const mk = require("marked");
      realMarked = (mk && mk.parse) || (mk && mk.marked && mk.marked.parse) || null;
    } catch (_) {}
    if (M && realMarked && rmSrc) {
      const sandbox = {};
      sandbox.window = sandbox;
      sandbox.console = console;
      sandbox.marked = { parse: (md, o) => realMarked(md, o || { gfm: true, breaks: true }) };
      sandbox.window.marked = sandbox.marked;
      sandbox.window.MTMathRender = M;
      sandbox.escapeHtml = (s) =>
        String(s == null ? "" : s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      sandbox.linkifyHtml = (h) => String(h || "");
      sandbox.I18n = { t: (s) => String(s) };
      vm.createContext(sandbox);
      vm.runInContext(rmSrc, sandbox, { filename: "app-renderMarkdown.js" });
      const rm = sandbox.renderMarkdown;

      const inline = rm("能量 $E=mc^2$ 结束");
      ok(
        has(inline, 'data-rv-tex="E=mc^2"') && has(inline, "rv-math") && !has(inline, "$E=mc^2$"),
        "行内公式 $E=mc^2$ 渲染成 .rv-math（不再是原文）",
      );
      const display = rm("$$\n\\frac{a}{b}\n$$");
      ok(has(display, "rv-math-display") && has(display, "rv-mfrac"), "显示公式 $$…$$ 独占一行渲染");
      const code = rm("`$no$`\n\n```\n$no$\n```");
      ok(has(code, "$no$"), "代码块 / 行内码里的 $ 不动");
      const money = rm("价格 $100 到 $200 元");
      ok(has(money, "$100") && has(money, "$200") && !has(money, "rv-math"), "金额不被误判成公式");
      /* AI 产出 / PDF 转 Markdown 的高频写法：`\(…\)` 行内 与 `\[…\]` 显示式（含跨行） */
      const bracketInline = rm("结果是 \\(x^2\\) 的");
      ok(
        has(bracketInline, 'data-rv-tex="x^2"') && has(bracketInline, 'data-rv-delim="\\("'),
        "行内 \\(…\\) 渲染成 .rv-math（AI 产出高频写法）",
      );
      const bracketDisplay = rm("\\[\n\\frac{a}{b}\n\\]");
      ok(
        has(bracketDisplay, "rv-math-display") && has(bracketDisplay, "rv-mfrac"),
        "显示式 \\[…\\] 跨行渲染",
      );
      ok(has(rm("$ x^2 $"), "rv-math"), "$ x^2 $ 内侧留白仍渲染（不再被紧贴口径误伤）");
      ok(
        !has(rm("行内码 `\\(x\\)` 原样"), "rv-math"),
        "行内码里的 `\\(…\\)` 不动（与代码块口径一致）",
      );
      const injected = rm("<img src=x onerror=1> $x^2$");
      ok(
        has(injected, "&lt;img") && has(injected, "rv-math"),
        "原始 HTML 仍被转义（注入防护未破），同段公式照常渲染",
      );
      ok(!M.TOKEN_RE.test(inline), "输出无 PUA 占位符残留");
      M.TOKEN_RE.lastIndex = 0;
    }
  }

  /* ═══════════ [6] KaTeX 离线内置（renderer/vendor/katex/）+ 真实语料回归 ═══════════ */

  console.log("\n[6] KaTeX 离线内置 + 真实语料回归（「数学」画布「综述」正文）");
  {
    /* 资源与接线：vendor 落盘 + 两个页面都挂 CSS/JS */
    const kdir = path.join(ROOT, "renderer", "vendor", "katex");
    ok(fs.existsSync(path.join(kdir, "katex.min.js")), "renderer/vendor/katex/katex.min.js 已落盘");
    ok(fs.existsSync(path.join(kdir, "katex.min.css")), "renderer/vendor/katex/katex.min.css 已落盘");
    let fontCount = 0;
    try {
      fontCount = fs.readdirSync(path.join(kdir, "fonts")).filter((f) => /\.woff2$/.test(f)).length;
    } catch (_) {}
    ok(fontCount >= 20, "vendor 携带 KaTeX 字体（woff2 " + fontCount + " 个）");
    const cssText = read("renderer/vendor/katex/katex.min.css");
    ok(
      (cssText.match(/url\(fonts\/[^)]+\.woff2\)/g) || []).length >= 20,
      "katex.min.css 的 @font-face 走 fonts/*.woff2 相对路径（打包内可解析）",
    );
    ok(
      has(read("renderer/index.html"), "vendor/katex/katex.min.css") &&
        has(read("renderer/index.html"), "vendor/katex/katex.min.js"),
      "index.html 挂载 KaTeX CSS/JS",
    );
    ok(
      has(read("renderer/pdf-print.html"), "vendor/katex/katex.min.css") &&
        has(read("renderer/pdf-print.html"), "vendor/katex/katex.min.js"),
      "pdf-print.html 同步挂载 KaTeX CSS/JS（否则导出 PDF 公式尺寸错乱）",
    );
    ok(
      /katexInner/.test(read("renderer/math-render.js")) &&
        /renderToString/.test(read("renderer/math-render.js")),
      "math-render.js 后端切到 KaTeX（katexInner / renderToString）",
    );

    /* ── 真跑：在 vm 沙箱里真加载 vendor 的 katex.min.js，再接 math-render.js ── */
    const katexPath = path.join(kdir, "katex.min.js");
    const mathPath = path.join(ROOT, "renderer", "math-render.js");
    let sandbox = null;
    let KM = null;
    if (fs.existsSync(katexPath)) {
      sandbox = {};
      sandbox.window = sandbox;
      sandbox.console = console;
      sandbox.setTimeout = setTimeout;
      sandbox.clearTimeout = clearTimeout;
      vm.createContext(sandbox);
      try {
        vm.runInContext(fs.readFileSync(katexPath, "utf8"), sandbox, { filename: "katex.min.js" });
        vm.runInContext(fs.readFileSync(mathPath, "utf8"), sandbox, { filename: "math-render.js" });
        KM = sandbox.MTMathRender;
      } catch (_) {
        KM = null;
      }
    }
    ok(!!(sandbox && sandbox.katex && typeof sandbox.katex.renderToString === "function"), "vm 沙箱里 KaTeX UMD 正常初始化（renderToString 可用）");
    ok(!!sandbox && /^\d+\.\d+\.\d+/.test(String((sandbox.katex || {}).version || "")), "KaTeX 版本号可读（" + (sandbox && sandbox.katex && sandbox.katex.version) + "）");
    ok(!!KM && typeof KM.latexToHtml === "function", "沙箱内 math-render.js 可就地取到 katex 并导出 latexToHtml");

    if (KM) {
      const inline = KM.latexToHtml("E=mc^2");
      ok(has(inline, 'class="katex"'), "行内公式交给 KaTeX 排版（产出 .katex）");
      ok(!has(inline, "katex-display"), "行内模式不加 .katex-display");
      ok(!has(inline, "rv-legacy"), "KaTeX 路径不带 rv-legacy（不叠加自研子集字形样式）");
      ok(
        !has(inline, "rv-msup") && !has(inline, "rv-mfrac"),
        "KaTeX 路径不再出自研 .rv-m* 字形节点",
      );

      const disp = KM.latexToHtml("\\frac{a}{b}", { display: true, delim: "\\[" });
      ok(has(disp, "katex-display"), "显示式公式走 KaTeX display 模式（.katex-display）");
      ok(has(disp, "rv-math-display"), "显示式仍带 .rv-math-display（包裹层契约不变）");

      /* 往返契约：data-rv-tex / data-rv-display / data-rv-delim 逐字保留 */
      ok(has(inline, 'data-rv-tex="E=mc^2"'), "data-rv-tex 原样保留");
      ok(has(inline, 'data-rv-display="0"') && has(disp, 'data-rv-display="1"'), "data-rv-display 行内 / 显示式正确");
      ok(has(inline, 'data-rv-delim="$"') && has(disp, 'data-rv-delim="\\["'), "data-rv-delim 保留原定界符（$ / \\[）");

      /* 错误公式：throwOnError:false → 不抛异常、出红字（.katex-error），仍包在 rv-math 里 */
      let err = null;
      try {
        err = KM.latexToHtml("\\frac{1}{");
      } catch (_) {
        err = null;
      }
      ok(typeof err === "string" && err.length > 0, "非法 LaTeX 不抛异常（throwOnError:false）");
      ok(has(err, "katex-error") && has(err, 'class="rv-math'), "非法 LaTeX 渲染成 .katex-error 且仍在 rv-math 包裹层内");

      /* 注入防护：trust:false 下 \href / \htmlClass 不被执行 */
      const href = KM.latexToHtml("\\href{javascript:alert(1)}{x}");
      ok(!/href="javascript:/.test(href), "trust:false 不被 \\href 注入（不产出 javascript: 链接）");

      const md = KM.mdToHtml("公式 $\\alpha$ 结束", (s) => "<p>" + s + "</p>");
      ok(has(md, 'class="katex"') && has(md, 'data-rv-tex="\\alpha"'), "mdToHtml 走 KaTeX 且保留 data-rv-tex");
      ok(!KM.TOKEN_RE.test(md), "KaTeX 路径无 PUA 占位符残留");
      KM.TOKEN_RE.lastIndex = 0;
    }

    /* ── 真实语料：「数学」画布 wf_mtyfjw6m「综述」节点正文 ──
       从本机数据目录只读读取（%APPDATA%\\pipeline-console 下的工作流存档），
       不落项目根、不改任何文件；找不到时打印一行说明并跳过（不误判失败）。 */
    const loadCorpus = () => {
      const bases = [];
      if (process.env.MTNODE_USERDATA) bases.push(process.env.MTNODE_USERDATA);
      if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, "pipeline-console"));
      const tries = [];
      for (const b of bases) {
        tries.push(path.join(b, "save", "wf_mtyfjw6m.json"));
        tries.push(path.join(b, "pipeline-console", "save", "wf_mtyfjw6m.json"));
      }
      const pick = (p) => {
        try {
          const wf = JSON.parse(fs.readFileSync(p, "utf8"));
          const nodes = (wf && wf.nodes) || [];
          const node = nodes.find((n) => n && n.title === "综述" && typeof n.text === "string");
          return node && node.text.length > 1000 ? node.text : null;
        } catch (_) {
          return null;
        }
      };
      for (const p of tries) {
        const t = pick(p);
        if (t) return t;
      }
      /* 存档改名也能找到：扫 save 目录里含「综述」节点的 wf 存档（上限 80 个，只读） */
      for (const b of bases) {
        for (const sub of [path.join(b, "save"), path.join(b, "pipeline-console", "save")]) {
          let files = [];
          try {
            files = fs.readdirSync(sub).filter((f) => /^wf_.*\.json$/.test(f)).slice(0, 80);
          } catch (_) {
            continue;
          }
          for (const f of files) {
            const t = pick(path.join(sub, f));
            if (t) return t;
          }
        }
      }
      return null;
    };

    const corpus = loadCorpus();
    if (!corpus) {
      console.log("  --    未在本机数据目录找到 wf_mtyfjw6m「综述」存档，跳过真实语料回归（渲染链路本身已由上条钉住）");
    } else {
      ok(corpus.length > 10000, "「综述」正文读到真实长度（" + corpus.length + " 字）");

      /* 用真 marked + 真 KaTeX 跑完整 renderMarkdown（与页面同一入口、同一口径） */
      const appjs = read("renderer/app.js");
      const rmSrc = (/function renderMarkdown\(text\)[\s\S]*?\r?\n}\r?\n/.exec(appjs) || [""])[0];
      let realMarked = null;
      try {
        const mk = require("marked");
        realMarked = (mk && mk.parse) || (mk && mk.marked && mk.marked.parse) || null;
      } catch (_) {}
      ok(rmSrc.length > 0 && !!realMarked && !!KM, "renderMarkdown + 真 marked + 真 KaTeX 三件套齐备");
      if (rmSrc && realMarked && KM) {
        const sb = {};
        sb.window = sb;
        sb.console = console;
        sb.setTimeout = setTimeout;
        sb.clearTimeout = clearTimeout;
        vm.createContext(sb);
        vm.runInContext(fs.readFileSync(katexPath, "utf8"), sb, { filename: "katex.min.js" });
        vm.runInContext(fs.readFileSync(mathPath, "utf8"), sb, { filename: "math-render.js" });
        sb.marked = { parse: (md, o) => realMarked(md, o || { gfm: true, breaks: true }) };
        sb.escapeHtml = (s) =>
          String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        sb.linkifyHtml = (h) => String(h || "");
        sb.I18n = { t: (s) => String(s) };
        vm.runInContext(rmSrc, sb, { filename: "app-renderMarkdown.js" });
        const html = sb.renderMarkdown(corpus);

        const expect = sb.MTMathRender.splitMath(corpus).items.length;
        const got = (html.match(/data-rv-tex=/g) || []).length;
        ok(expect > 150, "「综述」抽出公式数量符合预期（" + expect + " 条，>150）");
        ok(got === expect, "抽出的公式全部渲染（渲染 " + got + " / 抽出 " + expect + "）");

        /* 可见文本里的 LaTeX 命令 = 0：MathML 的 <annotation> 是隐藏的原文备份，
           统计前先摘掉，剩下才是用户真正看得见的字形（KaTeX 已排版 → 无 \asymp 这类源码） */
        const visible = html
          .replace(/<annotation[\s\S]*?<\/annotation>/g, "")
          .replace(/<[^>]*>/g, "");
        const residue = visible.match(/\\[a-zA-Z]+/g) || [];
        ok(
          residue.length === 0,
          "可见文本里 LaTeX 命令残留 0（实际 " + residue.length + "：" + [...new Set(residue)].slice(0, 8).join(",") + "）",
        );
        ok(
          (html.match(/katex-error/g) || []).length === 0,
          "无 .katex-error（没有任何公式被 KaTeX 判失败）",
        );
        ok(!/rv-legacy/.test(html), "整篇走 KaTeX 路径（未回退自研子集）");
        ok((html.match(/katex-display/g) || []).length > 0, "文中的显示式公式（\\[…\\]）渲染成 .katex-display");
        ok(!sb.MTMathRender.TOKEN_RE.test(html), "整篇输出无 PUA 占位符残留");
        sb.MTMathRender.TOKEN_RE.lastIndex = 0;
      }
    }
  }

  console.log(
    "\n" + (fails ? "FAIL" : "PASS") + " — " + checks + " 项，失败 " + fails + " 项",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-pdf-math-review.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-pdf-math-review.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

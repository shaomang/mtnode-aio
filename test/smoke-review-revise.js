"use strict";
/* 审阅 · 「让 AI 依据批注修订」回归（纯 Node，无 Electron / 无真实 DOM）
 *   node test/smoke-review-revise.js
 * 钉住的 bug：runRevision 在 push 新版本后、DOM 还停在上一版时调用 adoptLatestToNode()，
 * 其内部 commitEditorToDoc() 会把刚生成的新版正文覆盖回编辑器里的旧文 —— 用户看到
 * 「批注后点 AI 修订，内容没有任何变化」，且新版批注被清空、无从察觉。
 * 口径：新一版正文的真源是模型返回文本；adoptLatestToNode({skipCommit:true}) 跳过 DOM 落回；
 *       正常采用（关窗 / 手动）仍以编辑器 DOM 为准。
 */
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

/* ═══════════ 沙箱：只加载 app-review.js，渲染 / 落盘 / 调用全部打桩 ═══════════ */
function load() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;

  const calls = { canvas: 0, toasts: [], saved: 0, prompts: [] };
  sandbox.toast = (m) => calls.toasts.push(String(m));
  sandbox.renderCanvas = () => {
    calls.canvas++;
  };
  sandbox.scheduleSave = () => {
    calls.saved++;
  };
  sandbox.normalizeTextEffort = (v) => v;
  sandbox.apiCallTextStream = (spec) => {
    calls.prompts.push(spec.prompt);
    return Promise.resolve({ text: "# 新内容\n\n修订后的正文。" });
  };

  /* 编辑器宿主：querySelector 只认 commitEditorToDoc / renderRevisionButton 用到的几处。 */
  const editor = { contentEditable: "true", textContent: "", innerHTML: "<p>旧内容</p>" };
  const host = {
    querySelector: (sel) => {
      if (sel === ".rv-rich") return editor;
      if (sel === "#reviewReviseBtn" || sel === "#reviewReviseTxt")
        return { hidden: false, textContent: "" };
      return null;
    },
    classList: { toggle() {}, add() {}, remove() {} },
  };
  sandbox.document = {
    createElement: () => ({ style: {}, appendChild() {}, classList: { add() {}, remove() {} } }),
    getElementById: (id) => (id === "reviewBox" ? host : null),
  };

  const node = {
    id: "n1",
    kind: "proc_text",
    title: "文本节点",
    providerId: "p1",
    model: "m1",
    output: { kind: "text", text: "# 旧内容" },
    review: {
      createdAt: 1,
      versions: [
        {
          text: "# 旧内容",
          notes: [{ id: "rn1", kind: "full", body: "把标题改成新内容", snippet: "" }],
          ts: 1,
          src: "原始",
        },
      ],
      notesLog: [],
    },
  };
  sandbox.__node = node;
  sandbox.nodeById = (id) => (id === "n1" ? node : null);
  sandbox.S = {
    config: {
      providers: [{ id: "p1", type: "text_openai", apiKey: "k", models: ["m1"] }],
    },
    wf: { id: "wf", name: "画布" },
  };

  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-review.js"), sandbox, {
    filename: "app-review.js",
  });

  /* 富文本序列化打桩：真实实现要遍历 DOM，这里只回报「编辑器里现存的旧文」，
     以便精确复现「DOM 停在上一版」的时刻。 */
  sandbox.richToMarkdown = () => "# 旧内容";
  /* 渲染 / 落盘打桩：只验证数据链，不建整面 UI。 */
  sandbox.renderReviewView = () => {};
  sandbox.renderRevisionButton = () => {};
  sandbox.renderBusy = () => {};
  sandbox.persistReview = () => {
    calls.saved++;
  };
  vm.runInContext(
    "_rv.target = { type: 'node', id: 'n1', path: '', name: '文本节点' };" +
      "_rv.verIdx = 0; _rv.editing = true; _rv.busy = false;",
    sandbox,
  );
  return { sandbox, node, calls };
}

(async () => {
  console.log("[1] 修订后新版正文不被编辑器旧文覆盖（skipCommit）");
  {
    const { sandbox, node, calls } = load();
    await vm.runInContext("runRevision()", sandbox);
    ok(node.review.versions.length === 2, "生成了第 2 版");
    ok(
      node.review.versions[1] && node.review.versions[1].text === "# 新内容\n\n修订后的正文。",
      "新版正文 = 模型返回文本（未被编辑器旧文覆盖）",
    );
    ok(node.output && node.output.text === "# 新内容\n\n修订后的正文。", "节点输出同步为新版正文");
    ok(node.review.versions[1].notes.length === 0, "新版批注清空（进入下一轮）");
    ok(
      node.review.notesLog.length === 1 &&
        node.review.notesLog[0].body === "把标题改成新内容",
      "本轮批注已累计进 notesLog",
    );
    ok(
      calls.prompts.length === 1 &&
        calls.prompts[0].indexOf("# 旧内容") >= 0 &&
        calls.prompts[0].indexOf("把标题改成新内容") >= 0,
      "修订提示词含当前全文 + 批注",
    );
    ok(calls.canvas === 1, "采用后重绘画布一次");
    ok(
      calls.toasts.some((m) => m.indexOf("已生成修订版") >= 0),
      "成功提示",
    );
  }

  console.log("\n[2] 正常采用（关窗 / 手动）仍以编辑器 DOM 为准");
  {
    const { sandbox, node } = load();
    /* 用户手动改过正文 → 关窗采用时应当落盘编辑器里的那份 */
    sandbox.richToMarkdown = () => "# 手改后的正文";
    const r = vm.runInContext("adoptLatestToNode()", sandbox);
    ok(r === true, "adoptLatestToNode() 返回成功");
    ok(node.output.text === "# 手改后的正文", "未带 skipCommit 时采用编辑器正文");
  }

  console.log(
    "\n" + (fails ? "FAIL" : "PASS") + " — " + checks + " 项，失败 " + fails + " 项",
  );
  process.exit(fails ? 1 : 0);
})();

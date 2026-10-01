/* test/smoke-skill.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-skill.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-skill-slash-node.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-skill-slash-node.js";
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
  /* 从源码里按名字抠出顶层函数（不改动源文件，见 smoke-ref-keyboard.js 同套路） */
  function fnBody(src, name) {
    const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
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
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数体不完整：" + name);
  }
  const at = (src, needle) => src.indexOf(needle);

  const app = read("renderer/app.js");
  const canvas = read("renderer/app-canvas.js");
  const nodes = read("renderer/app-nodes.js");
  const i18n = read("renderer/i18n.js");

  console.log("[1] UI 接线：普通文本处理节点的提示词框也能呼出技能菜单");
  ok(
    canvas.indexOf('if (node.kind === "proc_text") slashTick(ta, "node", persistPrompt);') >= 0,
    "canvas compositionend：proc_text（含普通）触发 slashTick(ta, \"node\", persistPrompt)",
  );
  ok(
    canvas.indexOf('if (node.kind === "proc_text" && slashKey(ta, ev)) return;') >= 0,
    "keydown：slashKey 先消费 ↑↓ / Enter / Tab / Esc（被消费即 return）",
  );
  ok(
    canvas.indexOf('if (node.kind === "proc_text" && S.slashMenu) slashTick(ta, "node", persistPrompt);') >= 0,
    "click：菜单开着时按当前光标重筛",
  );
  {
    const kd = at(canvas, 'if (node.kind === "proc_text" && slashKey(ta, ev)) return;');
    const rk = at(canvas, "if (refKey(ta, ev, node)) return;");
    ok(kd > 0 && rk > 0 && kd < rk, "slashKey 在 refKey 之前消费（两套菜单各自处理，不互相截胡）");
  }
  ok(
    canvas.indexOf('I18n.t("提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）")') >= 0,
    "普通 proc_text 标签改为「提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）」",
  );
  ok(
    canvas.indexOf('I18n.t("任务（输入 / 呼出技能 · @ 引用输入节点）")') >= 0,
    "智能（agent）节点标签保持原样",
  );
  ok(
    canvas.indexOf("输入 @ 引用已连接节点 · 输入 / 或 、 呼出技能") >= 0,
    "普通 proc_text 的 textarea placeholder 补「输入 / 或 、 呼出技能」",
  );

  console.log("\n[2] app.js：input 监听同步放宽（边打字边筛）");
  {
    /* 按「函数名 + 头几个形参」定位：正文框后来加了可选的第 5 个形参（opts：refs 口径 /
       落回回调），这里不再钉死整条签名，免得每加一个可选参数就整段失效 */
    const mi = at(app, "function mountPromptTextarea(f3, ta, node, persistPrompt");
    const body = mi >= 0 ? app.slice(mi, mi + 1400) : "";
    ok(body.indexOf('if (node.kind === "proc_text") slashTick(ta, "node", persistPrompt);') >= 0,
      "mountPromptTextarea 的 input 监听对 proc_text（含普通）调 slashTick");
    const pv = body.indexOf("persistPrompt(ta.value);");
    const st = body.indexOf('if (node.kind === "proc_text") slashTick(ta, "node", persistPrompt);');
    ok(pv > 0 && st > pv, "先落库再重筛（与原有顺序一致）");
    ok(body.indexOf("if (isDshTask(node)) slashTick") < 0, "旧的 isDshTask 限定已不在 input 监听里");
  }
  ok(
    app.indexOf('if (t.charAt(0) === "\\u3001") t = "/" + t.slice(1);') >= 0,
    "resolveSkillSlash 认中文顿号 、 当 /（普通节点同样生效）",
  );
  ok(/const m = t\.match\(\/\^\\\/\(\[a-zA-Z0-9_-\]\+\)/.test(app),
    "resolveSkillSlash 仍解析行首 /技能名 [说明]");
  ok(/function slashKey\(ta, ev\)/.test(app) && /if \(ev\.key === "Enter" \|\| ev\.key === "Tab"\)/.test(app),
    "slashKey 未改动（回车 / Tab 确认、↑↓ 选择、Esc 收起）");
  ok(/function slashTick\(ta, scope, onChange\)/.test(app) && /scope !== "node" \|\| !isCanvasBuildSkillName/.test(app),
    "slashTick scope=node 仍过滤画布类技能（generate-workflow / generate-task）");

  console.log("\n[3] 运行路径：技能说明书在 @ 引用解析之后就地展开");
  ok(nodes.indexOf("function buildSpec(node, prov, idx, skillWrap) {") >= 0,
    "buildSpec 新增可选 skillWrap 参数");
  ok(nodes.indexOf("function buildSpecAgg(node, prov, skillWrap) {") >= 0,
    "buildSpecAgg 新增可选 skillWrap 参数");
  {
    const b1 = at(nodes, "function buildSpec(node, prov, idx, skillWrap) {");
    const seg1 = nodes.slice(b1, b1 + 1600);
    const rr = seg1.indexOf("resolveRefs(runPrompt, node, idx);");
    const aw = seg1.indexOf("applySkillWrapToAssembled(");
    ok(rr > 0 && aw > rr, "buildSpec：applySkillWrapToAssembled 在 resolveRefs 之后（正文里的 @ / / 不被二次解析）");
    ok(seg1.indexOf("skillWrap.raw") >= 0 && seg1.indexOf("skillTaskPrompt(skillWrap)") >= 0,
      "buildSpec：以 skillWrap.raw 定位、skillTaskPrompt 包装");
    const b2 = at(nodes, "function buildSpecAgg(node, prov, skillWrap) {");
    const seg2 = nodes.slice(b2, b2 + 2600);
    const rr2 = seg2.indexOf("resolveRefsAgg(runPrompt, node);");
    const aw2 = seg2.indexOf("applySkillWrapToAssembled(");
    ok(rr2 > 0 && aw2 > rr2, "buildSpecAgg：同样在 resolveRefsAgg 之后展开");
  }
  ok(/resolveSkillSlash\(procPromptForRun\(node\), \{\s*\r?\n\s*denyCanvasSkills: true,\s*\r?\n\s*\}\)/.test(nodes),
    "普通节点统一走 resolveSkillSlash(procPromptForRun(node), { denyCanvasSkills: true })");
  {
    const r1 = at(nodes, "async function runOnce(node, prov, idx, itemTitle, attemptT) {");
    const seg = nodes.slice(r1, r1 + 900);
    ok(/const dshTask = isDshTask\(node\);/.test(seg), "runOnce 先判 dshTask");
    ok(/const skillWrap = dshTask\s*\n?\s*\? null\s*\n?\s*: await resolveSkillSlash\(/.test(seg),
      "runOnce：智能任务节点不重复展开（避免二次包装），仅普通节点解析");
    ok(seg.indexOf("buildSpec(node, prov, idx, skillWrap)") >= 0, "runOnce 把 skillWrap 传进 buildSpec");
    const r2 = at(nodes, "async function runOnceAgg(node, prov, attemptT) {");
    const seg2 = nodes.slice(r2, r2 + 900);
    ok(/const dshTask = isDshTask\(node\);/.test(seg2), "runOnceAgg 同口径");
    ok(seg2.indexOf("buildSpecAgg(node, prov, skillWrap)") >= 0, "runOnceAgg 把 skillWrap 传进 buildSpecAgg");
    const pv = at(nodes, "/* 行首 /技能名：预览也走同口径，看到的就是真正会发出去的内容 */");
    const seg3 = nodes.slice(pv, pv + 600);
    ok(seg3.indexOf("await resolveSkillSlash(procPromptForRun(node), {") >= 0 &&
       seg3.indexOf("buildSpec(node, prov, 0, skillWrap)") >= 0,
      "previewNode：预览即所见即所发（同口径解析并传入 buildSpec）");
  }
  ok(nodes.indexOf("await resolveSkillSlash(procPromptForRun(node),") >= 0 &&
     nodes.indexOf('typeof applySkillWrapToAssembled === "function"') >= 0,
    "普通节点仍走原 apiCallTextStream 路径（不改成 dsh 任务）");

  console.log("\n[4] 行为：真实函数（vm 取源码，不碰源文件）");
  const sandbox = {
    console, Math, JSON, String, Number, RegExp, Array, Object, Error,
    I18n: { t: (s) => s },
  };
  vm.runInNewContext(
    fnBody(app, "slashToken") + "\n" + fnBody(app, "applySkillWrapToAssembled") +
      "\n;Object.assign(__api, { slashToken, applySkillWrapToAssembled });",
    Object.assign(sandbox, { __api: {} }),
  );
  const { slashToken, applySkillWrapToAssembled } = sandbox.__api;
  const mk = (value, caret) => ({ value, selectionStart: caret == null ? value.length : caret });

  {
    const a = slashToken(mk("/mu"));
    ok(a && a.trigger === "/" && a.query === "mu", "行首「/」触发：query=mu");
    const b = slashToken(mk("、mu"));
    ok(b && b.trigger === "、" && b.query === "mu", "中文顿号「、」同样触发（输入法 / 打成 、 也能用）");
    const c = slashToken(mk("/minimax-music"));
    ok(c && c.query === "minimax-music", "技能名带 - 也照常解析（query=minimax-music）");
    ok(slashToken(mk("/minimax-music 写一首")) === null, "技能名后打空格即收起菜单（正文继续写，token 结束）");
    ok(slashToken(mk("正文里 /mu")) === null, "/ 前有正文（非行首）时不误弹菜单");
    ok(slashToken(mk("第一行\n/decompose")) !== null, "换行后行首 / 触发");
  }
  {
    const raw = "/minimax-music 写一首轻快的歌";
    const wrapped = "请使用技能「MiniMax 音乐」。\n\n写一首轻快的歌\n\n—— 技能说明书 ——\n步骤 @某节点 /help";
    const assembled = "【背景信息】\n### 输入\n内容\n\n【内容】\n" + raw;
    const out = applySkillWrapToAssembled(assembled, raw, wrapped);
    ok(out.indexOf(raw) < 0 && out.indexOf(wrapped) >= 0, "整段 raw 被技能说明书就地替换");
    ok(out.indexOf("【背景信息】") === 0, "【背景信息】块不受影响");
    ok(out.indexOf("@某节点 /help") > 0, "技能正文里的 @ / / 原样保留（不再被解析）");
    const out2 = applySkillWrapToAssembled("【背景信息】\n\n【内容】\n别的文本", "找不到的原文", wrapped);
    ok(out2.indexOf(wrapped) >= 0 && out2.indexOf("【背景信息】") === 0,
      "原文定位不到时按【内容】标记兜底追加说明书（不丢上文）");
    ok(applySkillWrapToAssembled("", "", wrapped) === wrapped, "空 assembled 时直接返回说明书");
  }

  console.log("\n[5] i18n：新增两条文案中英成对、无重复键");
  ok(
    i18n.indexOf('"提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）": "Prompt (@ to reference input nodes · type / for skills)"') >= 0,
    "标签词条中英成对",
  );
  ok(
    i18n.indexOf('"例如：将输入内容总结为三句话… 输入 @ 引用已连接节点 · 输入 / 或 、 呼出技能":') >= 0 &&
    i18n.indexOf("e.g. Summarize the input in three sentences… type @ to reference connected nodes · type / or 、 for skills") >= 0,
    "占位词条中英成对",
  );
  for (const key of [
    '"提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）"',
    '"例如：将输入内容总结为三句话… 输入 @ 引用已连接节点 · 输入 / 或 、 呼出技能"',
  ]) {
    const re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    ok((i18n.match(re) || []).length === 1, "无重复键：" + key.slice(0, 22) + "…");
  }
  ok(
    (i18n.match(/"暂无匹配的命令或技能"/g) || []).length === 1,
    "斜杠菜单词条「暂无匹配的命令或技能」仍只一处（复用，不新增）",
  );
  ok(
    i18n.indexOf('"任务（输入 / 呼出技能 · @ 引用输入节点）":') >= 0 &&
    i18n.indexOf('"Task (type / for skills · @ to reference inputs)"') >= 0,
    "相邻既有标签词条仍成对",
  );

  console.log(
    (fails ? "\n✗ FAIL " : "\n✓ 全部 ") +
      checks +
      " 项" +
      (fails ? "，失败 " + fails + " 项" : "通过"),
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-skill-slash-node.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-skill-slash-node.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-skill-md-editor.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-skill-md-editor.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");

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
  /* 取某函数体：从签名起到「行首 }」为止（够静态断言用，不 pretending 解析 JS） */
  function fnBody(src, sig) {
    const i = src.indexOf(sig);
    if (i < 0) return "";
    const j = src.indexOf("\n}", i);
    return j < 0 ? src.slice(i) : src.slice(i, j);
  }

  const app = read("renderer/app.js");
  const plugins = read("renderer/app-plugins.js");
  const css = read("renderer/css/dsh.css");
  const i18n = read("renderer/i18n.js");

  console.log("[1] 内置 Markdown 阅读器 · 虚拟文档模式");
  ok(
    app.indexOf('const virtual = typeof opts.content === "string";') >= 0,
    "openMdViewer 认 opts.content = 虚拟文档（不解析磁盘路径）",
  );
  ok(
    app.indexOf(
      "_mdViewerState.onSave = typeof opts.onSave === \"function\" ? opts.onSave : null;",
    ) >= 0,
    "onSave 回调登记进 _mdViewerState",
  );
  ok(
    app.indexOf("_mdViewerState.editing = virtual ? !!opts.edit && !opts.readOnly : false;") >=
      0,
    "opts.edit 直接进编辑态 · opts.readOnly 只读",
  );
  const openFn = fnBody(app, "async function openMdViewer(filePath, opts)");
  ok(
    openFn.indexOf("renderMdViewerContent(opts.content);") >= 0 &&
      openFn.indexOf("renderMdViewerContent(opts.content);") <
        openFn.indexOf("const rr = await window.api.fileReadText(resolved);"),
    "虚拟文档不走 fileReadText，直接渲染传入正文",
  );
  ok(
    app.indexOf('_mdViewerState.virtual ? "none" : ""') >= 0,
    "虚拟文档隐藏「刷新 / 位置」（没有磁盘文件可重载定位）",
  );
  ok(
    app.indexOf('eb.style.display = _mdViewerState.readOnly ? "none" : "";') >= 0,
    "只读文档不显示「编辑」入口",
  );

  console.log("\n[2] 实时保存 / 关窗：正文交回调用方，不写磁盘");
  /* 实时保存（本轮）：顶部「保存」按钮已移除，落盘口是 mdViewerCommit
     —— 编辑态一改就防抖落盘，虚拟文档同样走 onSave（不 fileWriteText）。 */
  const saveFn = fnBody(app, "async function mdViewerCommit()");
  ok(saveFn.indexOf("if (_mdViewerState.virtual) {") >= 0, "mdViewerCommit 先分虚拟文档支");
  const vBlock = saveFn.slice(
    saveFn.indexOf("if (_mdViewerState.virtual) {"),
    saveFn.indexOf("const p = _mdViewerState.path;"),
  );
  ok(
    vBlock.indexOf("await _mdViewerState.onSave(content)") >= 0,
    "虚拟文档落盘 = 调 onSave（不 fileWriteText）",
  );
  ok(vBlock.indexOf("fileWriteText") < 0, "虚拟文档分支里没有 fileWriteText");
  ok(
    saveFn.indexOf("const r = await window.api.fileWriteText(p, content);") >= 0,
    "文件模式仍原样写回磁盘",
  );
  ok(
    app.indexOf('id="mdViewerSaveBtn"') < 0 && app.indexOf("function mdViewerScheduleSave()") >= 0,
    "「保存」按钮已移除，改成停笔即落盘（mdViewerScheduleSave）",
  );
  const closeFn = fnBody(app, "function closeMdViewer()");
  ok(
    closeFn.indexOf("flushMdViewerSave()") >= 0,
    "关窗（✕ / Esc）先把待落盘的一笔写完，不丢草稿",
  );
  ok(
    app.indexOf("_mdViewerState.virtual && _mdViewerState.editing && _mdViewerState.onSave") < 0,
    "关窗不再补一次 onSave（实时保存已交回）",
  );
  ok(
    closeFn.indexOf("closeMdViewer") < 0 ||
      closeFn.indexOf("host.classList.remove") >= 0,
    "关窗仍只是收浮层（不重建 DOM）",
  );

  console.log("\n[3] 技能表单：正文走内置编辑器（不再裸 textarea）");
  ok(
    plugins.indexOf("const body = extTextArea(") < 0,
    "技能表单已无 extTextArea 正文框",
  );
  ok(
    plugins.indexOf('mdBtn.textContent = I18n.t("✎ 用内置 Markdown 编辑器");') >= 0,
    "表单给出「✎ 用内置 Markdown 编辑器」入口",
  );
  ok(
    plugins.indexOf('openMdViewer("", {') >= 0 &&
      plugins.indexOf('content: String(bodyText || ""),') >= 0,
    "入口以虚拟文档打开内置编辑器（content = 当前草稿）",
  );
  ok(
    plugins.indexOf('bodyText = String(text == null ? "" : text);') >= 0,
    "编辑器保存回填 bodyText",
  );
  ok(plugins.indexOf("body: bodyText,") >= 0, "skillAdd 提交的是编辑器里的正文");
  ok(
    plugins.indexOf("paintSkillBody();") >= 0 &&
      plugins.indexOf('mdPrev.className = "dsh-skill-md-prev md";') >= 0,
    "表单里保留渲染预览（点预览同样进编辑器）",
  );
  ok(
    plugins.indexOf("mdPrev.onclick = openSkillBodyEditor;") >= 0,
    "预览可点，直接用内置编辑器打开",
  );

  console.log("\n[4] 内置技能只读：用内置阅读器打开");
  ok(
    plugins.indexOf("async function openSkillMarkdownViewer(s, opts)") >= 0,
    "新增 openSkillMarkdownViewer（统一走内置 Markdown 阅读 / 编辑器）",
  );
  ok(
    plugins.indexOf("await openSkillMarkdownViewer(s, { readOnly: true });") >= 0,
    "内置技能「阅读」= 只读打开",
  );
  ok(
    plugins.indexOf("await openSkillMarkdownViewer(s, { readOnly: true });") >= 0 &&
      plugins.indexOf('extState("skill").editor = { mode: "edit", data: s };') >= 0,
    "本机技能仍走表单（含内置编辑器），内置技能不进编辑表单",
  );

  console.log("\n[5] 样式 / 词条 / 层级");
  ok(css.indexOf(".dsh-skill-md-prev {") >= 0, "css 有 .dsh-skill-md-prev 预览框");
  ok(css.indexOf(".dsh-skill-md-prev.empty {") >= 0, "空正文时预览框收起");
  ok(css.indexOf(".dsh-skill-md .mini {") >= 0, "入口按钮左对齐（不继承表单 mini 的 flex-end）");
  for (const k of [
    '"Markdown 编辑器": "Markdown Editor"',
    '"✎ 用内置 Markdown 编辑器": "✎ Use the built-in Markdown editor"',
    '"内置 Markdown 编辑器不可用": "Built-in Markdown editor unavailable"',
    '" · 只读": " · read-only"',
    '"阅读": "Read"',
  ]) {
    ok(i18n.indexOf(k) >= 0, "英文词条：" + k.split(":")[0].replace(/"/g, ""));
  }
  const zDlg = /\.dsh-plugins-dlg\s*\{[^}]*z-index:\s*(\d+)/.exec(css);
  const zMd = /\.yaml-viewer-dlg\s*\{[^}]*z-index:\s*(\d+)/.exec(read("renderer/css/assist.css"));
  ok(
    zDlg && zMd && Number(zMd[1]) > Number(zDlg[1]),
    "Markdown 阅读器浮层盖在扩展能力管理窗之上（" +
      (zMd && zMd[1]) +
      " > " +
      (zDlg && zDlg[1]) +
      "）",
  );

  console.log(
    (fails ? "\n✗ FAIL " : "\n✓ 全部 ") +
      checks +
      " 项" +
      (fails ? "，失败 " + fails + " 项" : "通过"),
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-skill-md-editor.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-skill-md-editor.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-skill-update.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-skill-update.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const crypto = require("crypto");

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
  /* 源码统一按 \n 处理（仓库是 CRLF，切段与断言不必管行尾差异） */
  const read = (rel) =>
    fs
      .readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n/g, "\n");
  const has = (src, needle, label) => ok(src.indexOf(needle) >= 0, label);
  const I18N = require(path.join(ROOT, "renderer", "i18n.js"));

  console.log("[1] 目录侧：build.mjs 每条技能带 version + sha256");
  {
    const b = read("ext-repo/build.mjs");
    has(b, 'import crypto from "node:crypto"', "build.mjs 引 node:crypto");
    has(b, "function sha256Hex(buf)", "build.mjs 有 sha256Hex 指纹函数");
    has(
      b,
      'crypto.createHash("sha256").update(buf).digest("hex")',
      "指纹算法 = sha256 hex",
    );
    has(b, "version: meta.version", "目录条目带 version（frontmatter 有就抄）");
    has(b, "sha256: sha256Hex(Buffer.from(text, \"utf8\"))", "目录条目带 SKILL.md 正文指纹");
    has(
      read("ext-repo/README.md"),
      "只改正文也能被识别为有更新",
      "ext-repo/README 写明「只改正文也判有更新、记得 ext:sync」",
    );
  }

  console.log("[2] 宿主侧：skillList() 给每个已装技能同一份指纹");
  {
    const d = read("dsh/main-dsh.js");
    has(d, "const crypto = require('crypto')", "main-dsh.js 引 crypto");
    has(d, "function sha256Hex(buf)", "main-dsh.js 有 sha256Hex（与目录同算法）");
    const list = d.slice(d.indexOf("skillList() {"), d.indexOf("skillGet(name) {"));
    has(list, "sha256 = sha256Hex(body)", "skillList 真算指纹（读的是 SKILL.md 字节）");
    has(list, "sha256,", "skillList 回执带 sha256 字段");
    ok(
      d.indexOf("sha256 = sha256Hex(body)") > 0 &&
        d.indexOf("'utf8'") > 0 &&
        list.indexOf("fs.readFileSync(skillMd)") >= 0,
      "指纹取自 SKILL.md 原文（不是标题/描述拼接）",
    );
  }

  console.log("[3] 客户端：设置·在线 给已装技能「更新」入口 + 按指纹判有更新");
  {
    const s = read("renderer/app-settings.js");
    has(
      s,
      "const installSkillFromRepo = async (it, repo, opts)",
      "安装 / 更新共用一次下载落盘（不再各写一遍）",
    );
    has(s, "overwrite: !!opts.overwrite", "更新走 skillAdd overwrite（否则同名被拒）");
    has(s, "const skillHasUpdate = (it, rec)", "有专门的「该不该更新」判定函数");
    has(s, "String(it.sha256) !== String(rec.sha256)", "优先比正文指纹");
    has(s, "String(it.version) !== String(rec.version)", "没有指纹时退回版本号比较");
    has(s, 'tag.textContent = hasUpdate ? I18n.t("有更新") : I18n.t("已安装")', "卡片如实显示「有更新」");
    has(s, "installSkillFromRepo(it, repo, {\n                overwrite: true,\n              })", "更新按钮真的覆盖落盘");
    has(s, 'sha256: String(raw.sha256 || "")', "目录条目把 sha256 带进卡片数据");
    has(
      s,
      'I18n.t("将用线上目录版本覆盖本机技能「{name}」。确定更新？"',
      "覆盖前先确认（不静默改写用户机上的技能）",
    );
  }

  console.log("[4] 工坊：有更新 = version 变了 / 远端 updatedAt 更新");
  {
    const st = read("renderer/app-store.js");
    const seg = st.slice(st.indexOf("const remoteAt = Number(item.updatedAt) || 0;"));
    const block = seg.slice(0, seg.indexOf("if (installed) {"));
    has(block, "remoteAt > localAt", "updatedAt 更新即算有更新（同版本号重新上架）");
    has(block, "String(local.version) !== String(item.version)", "version 比较保留");
    has(block, "Number(local && local.storeUpdatedAt) || 0", "本地侧取 .store-meta.json 的 updatedAt");
  }

  console.log("[5] i18n：新增词条中英齐备");
  {
    const pairs = [
      "有更新",
      "已更新 ",
      "更新失败：",
      "线上目录已换新版，点此覆盖本机技能",
      "重新下载并覆盖本机技能",
      "将用线上目录版本覆盖本机技能「{name}」。确定更新？",
    ];
    for (const k of pairs) {
      I18N.setLocale("en");
      const en = I18N.t(k);
      I18N.setLocale("zh");
      ok(en !== k, "英文词条： " + k + " → " + en);
    }
  }

  console.log("[6] 两侧指纹算法同源（真跑宿主函数）");
  {
    const d = read("dsh/main-dsh.js");
    const at = d.indexOf("function sha256Hex(buf) {");
    const from = d.slice(at, d.indexOf("\n}", at) + 2);
    const ctx = { crypto, module: { exports: {} } };
    vm.createContext(ctx);
    vm.runInContext(from + "\nsha256Hex = sha256Hex;", ctx);
    const sample = Buffer.from("# 提示词\n七层散文体\n", "utf8");
    const mine = ctx.sha256Hex(sample);
    const ref = crypto.createHash("sha256").update(sample).digest("hex");
    ok(mine === ref, "宿主 sha256Hex == node:crypto sha256 hex");
    const trueSkill = fs.readFileSync(
      /* 取一份仍在工坊发版的技能正文当真实样本
         （minimax-music-* 已改为随包内置，见 mtnode-agent-skills/music/，不在这里） */
      path.join(ROOT, "ext-repo", "skills", "generate-workflow", "SKILL.md"),
    );
    ok(
      ctx.sha256Hex(trueSkill) ===
        crypto.createHash("sha256").update(trueSkill).digest("hex"),
      "对真实技能文件同样成立（目录 / 宿主同一份指纹）",
    );
  }

  console.log("");
  console.log(fails ? "FAILED " + fails + "/" + checks : "ALL OK " + checks);

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-skill-update.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-skill-update.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

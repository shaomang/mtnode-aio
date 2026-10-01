/* test/smoke-global.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-global.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-global-search.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-global-search.js";
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
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n/g, "\n");
  const show = (v) => JSON.stringify(v);

  const app = read("renderer/app.js");
  const search = read("renderer/app-search.js");
  const html = read("renderer/index.html");
  const style = read("renderer/style.css");
  const css = read("renderer/css/search.css");
  const canvasCss = read("renderer/css/canvas.css");
  const i18n = read("renderer/i18n.js");
  const boot = read("renderer/app-boot.js");
  const assist = read("renderer/app-assist.js");
  const tools = read("renderer/app-tools.js");

  console.log("\n[1] 模块接线：新文件被 index.html 与 style.css 收进来");
  {
    ok(html.indexOf('<script src="app-search.js"></script>') > 0, "index.html 引入 app-search.js");
    ok(
      html.indexOf('src="app-teamview.js"') < html.indexOf('src="app-search.js"') &&
        html.indexOf('src="app-search.js"') < html.indexOf('src="app-boot.js"'),
      "加载顺序：app-teamview.js → app-search.js → app-boot.js（专家团 / 手册跳转要用它们）",
    );
    ok(style.indexOf('@import url("./css/search.css")') > 0, "style.css 聚合 css/search.css");
    ok(fs.existsSync(path.join(__dirname, "..", "renderer", "css", "search.css")), "css/search.css 存在");
    const z = Number((css.match(/\.gs-layer\s*\{[^}]*z-index:\s*(\d+)/) || [])[1] || 0);
    ok(z > 10055, "浮层层级高于全仓最高 z-index（拖影 10055）：z-index=" + z);
    ok(boot.indexOf("globalSearchRepaint()") > 0, "app-boot.js 切语言时重绘浮层文案");
  }

  console.log("\n[2] 分类清单：需求点名的区域一个不少");
  {
    const cats = ["canvas", "session", "team", "asset", "tool", "skill", "tpl", "doc"];
    for (const c of cats)
      ok(search.indexOf('{ id: "' + c + '"') > 0, "分类含 " + c);
    for (const label of [
      "画布（跨画布）",
      "会话记录",
      "专家团",
      "素材库与本机文件",
      "工具库",
      "技能",
      "模板商店",
      "手册文档",
    ])
      ok(search.indexOf('"' + label + '"') > 0, "分类标签 " + label);
    ok(
      search.indexOf("api.wfList") > 0 && search.indexOf("api.wfLoad") > 0,
      "画布跨画布取数：wfList + wfLoad",
    );
    ok(search.indexOf("agentSessions()") > 0, "会话走 agentSessions()");
    ok(search.indexOf("teamChats()") > 0 && search.indexOf("teamExperts()") > 0, "专家团走 teamChats / teamExperts");
    ok(search.indexOf("api.assetsScan") > 0, "素材库走 assetsScan");
    ok(search.indexOf("api.toolsList") > 0, "工具库走 toolsList");
    ok(search.indexOf("loadSkillsCached") > 0, "技能走 loadSkillsCached");
    ok(search.indexOf('"/api/templates?q="') > 0, "模板商店走创意工坊列表接口");
    ok(search.indexOf("docsCatalog") > 0 && search.indexOf("guideLoad") > 0, "手册文档走 docsCatalog + guideLoad");
  }

  console.log("\n[3] 触发口径：Ctrl+F / 0.5s 防抖 / 最短 2 字符 / 可编辑区让位");
  {
    ok(
      app.indexOf('if (mod && key === "f" && !ev.altKey && !ev.shiftKey)') > 0,
      "app.js 拦截 Ctrl+F",
    );
    ok(app.indexOf("openGlobalSearch()") > 0, "拦截后呼出 openGlobalSearch()");
    const keyHandler = app.slice(
      app.indexOf('window.addEventListener("keydown", (ev) => {'),
      app.indexOf('/* Esc 收起画布菜单'),
    );
    ok(
      keyHandler.indexOf('if (mod && key === "f"') > 0 &&
        keyHandler.indexOf('if (mod && key === "f"') <
          keyHandler.indexOf('docsHost.classList.contains("on")'),
      "Ctrl+F 分支排在手册阅读器等浮层早退之前（任何界面都能呼出）",
    );
    ok(app.indexOf("if (!inField && typeof openGlobalSearch") > 0, "焦点在可编辑区时让位给编辑器自带查找");
    ok(/},\s*500\);/.test(search), "防抖 500ms");
    ok(search.indexOf("q.trim().length < 2") > 0, "不足 2 个字符不开搜");
    ok(search.indexOf("至少输入 2 个字符开始搜索") > 0, "短查询给出提示");
    ok(
      search.indexOf('GS.loading.asset = true') > search.indexOf("gsCollectDocBodies("),
      "文件正文排在最后（第三波）：先手册/节点指南/模板商店",
    );
    ok(search.indexOf("正在搜索文件内容…") > 0, "文件正文搜索时该类标题显示「正在搜索文件内容…」");
    ok(search.indexOf("GS_DEFAULT_SHOWN = 20") > 0, "每类默认 20 条");
    ok(search.indexOf("显示更多") > 0, "超出可「显示更多」");
    ok(
      search.indexOf("GS.items.filter((it) => it.cat === cat.id)") > 0 && search.indexOf('GS.tab !== "all"') > 0,
      "按分类分组展示，分栏 Tabs 可筛选（默认全部）",
    );
    ok(search.indexOf("点开结果后自动关闭") > 0, "脚注写明点开结果后关浮层");
    ok(
      search.indexOf("input.value = opts.keep ? input.value : GS.last || \"\"") > 0 &&
        search.indexOf("input.select()") > 0,
      "下次呼出回填上次查询并全选",
    );
  }

  console.log("\n[4] 旧画布查找 / 替换：整体移除（Ctrl+G 与替换 UI 都不在）");
  {
    for (const sym of [
      "openCanvasFindBar",
      "closeCanvasFindBar",
      "canvasFindRefresh",
      "collectCanvasFindMatches",
      "replaceInNodeFields",
      "canvasFindBar",
      "S.findBar",
    ]) {
      ok(app.indexOf(sym) < 0, "app.js 不再有 " + sym);
    }
    ok(app.indexOf('mod && key === "g"') < 0, "Ctrl+G 替换入口已移除（画布的 G 成组快捷键不受影响）");
    ok(assist.indexOf("closeCanvasFindBar") < 0 && boot.indexOf("findBar") < 0, "app-assist / app-boot 的旧查找引用清干净");
    ok(canvasCss.indexOf(".canvas-find-bar") < 0, "css/canvas.css 删掉 .canvas-find-bar 规则");
    ok(
      i18n.indexOf('"查找节点（标题 / 内容）…"') < 0 &&
        i18n.indexOf('"全部替换": "Replace all"') < 0 &&
        i18n.indexOf('"未找到匹配的节点"') < 0,
      "i18n 清掉旧查找 / 替换词条",
    );
    ok(
      i18n.indexOf('"批量替换": "Batch replace"') < 0,
      "业务类「批量替换服务商」词条随无效模型弹窗一起移除（模型不可见改为静默无模型）",
    );
    ok(i18n.indexOf('"替换…": "Replace…"') > 0, "设置里的「替换…」保留");
  }

  console.log("\n[5] 结果跳转：每类都有定位出口");
  {
    for (const [kind, fn] of [
      ["canvasNode", "gsGotoCanvas"],
      ["session", "gsGotoSession"],
      ["team", "gsGotoTeam"],
      ["asset", "gsGotoAsset"],
      ["tool", "gsGotoTool"],
      ["skill", "gsGotoSkill"],
      ["tpl", "gsGotoTpl"],
      ["doc", "gsGotoDoc"],
      ["guide", "gsGotoGuide"],
    ]) {
      ok(
        search.indexOf('g.kind === "' + kind + '"') > 0 && search.indexOf("function " + fn + "(") > 0,
        "结果类型 " + kind + " → " + fn + "()",
      );
    }
    ok(
      search.indexOf("await loadWorkflow(wfId)") > 0 && search.indexOf("focusNode(g.nodeId)") > 0,
      "画布结果：跨画布先 loadWorkflow 再 focusNode 选中节点",
    );
    /* 定位必须真的切过去：
       · 判据用前台真源 currentVisibleWf()，不用可能被后台编辑借走的 S.wf；
       · loadWorkflow 见「目标已是 S.wf」会直接返回，此时补一次 setForegroundWf；
       · 目标就是可见画布、S.wf 却被借走时，把前台真源指回来再 focusNode；
       · 盖住画面的浮窗（设置 / 工具库 / 创意工坊 = #overlay，素材库、手册阅读器）先收掉。 */
    ok(
      search.indexOf("const vis0 = typeof currentVisibleWf === \"function\"") > 0 &&
        search.indexOf("let switched = visId0 === wfId") > 0,
      "画布定位以前台真源 currentVisibleWf() 判定，而不是可能被借走的 S.wf",
    );
    ok(
      search.indexOf('if (!switched && S.wf && gsStr(S.wf.id) === wfId && typeof setForegroundWf === "function")') > 0 &&
        search.indexOf("setForegroundWf(S.wf);") > 0,
      "loadWorkflow 因「目标已是 S.wf」直接返回时，补一次前台切换",
    );
    ok(
      search.indexOf("} else if (vis0 && S.wf !== vis0 && typeof setForegroundWf === \"function\")") > 0 &&
        search.indexOf("setForegroundWf(vis0);") > 0,
      "目标已是可见画布、S.wf 被后台借走时：指回前台真源再定位节点",
    );
    ok(
      search.indexOf("function gsDismissCoveringLayers()") > 0 &&
        search.indexOf("closeAssetLib()") > 0 &&
        search.indexOf("closeExtManagerDialog()") > 0 &&
        search.indexOf("closeAppDocs()") > 0 &&
        search.indexOf("closeOverlay()") > 0,
      "定位前收掉盖住目标的浮窗：#overlay / 素材库 / 扩展管理 / 手册阅读器",
    );
    ok(
      search.indexOf("async function gsGotoCanvas(g) {\n  gsDismissCoveringLayers();") > 0 &&
        search.indexOf("async function gsGotoTeam(g) {\n  gsDismissCoveringLayers();") > 0,
      "画布与专家团定位都先收浮窗",
    );
    ok(
      search.indexOf("if (typeof nodeById === \"function\" && !nodeById(g.nodeId))") > 0 &&
        search.indexOf('toast(I18n.t("节点不在当前画布"), "warn")') > 0,
      "切过去后节点仍不在该画布：明确提示，不再静默什么都不发生",
    );
    ok(
      search.indexOf('toast(I18n.t("打开失败：") + wfId, "err")') > 0,
      "画布没切成功时给出失败提示（不再静默）",
    );
    ok(
      search.indexOf("histMsgKey(st.id, g.msgIndex") > 0 && search.indexOf('"gs-flash"') > 0,
      "会话结果：按 histKey 滚动到命中消息并高亮",
    );
    ok(
      search.indexOf("teamViewSetSel(sel)") > 0 && search.indexOf('document.getElementById("teamChatListMsgs")') > 0,
      "专家团结果：切到该会话再滚动到命中消息",
    );
    ok(
      tools.indexOf("row.dataset.toolId") > 0,
      "工具库行带 data-tool-id，供搜索定位高亮",
    );
    ok(
      search.indexOf("ASSET_LIB.selAssetId = g.assetId") > 0,
      "素材结果：先在库里选中该素材再开库",
    );
  }

  console.log("\n[6] persistent：只走显式关闭路径，不挂「点外部即关」");
  {
    const outsideClose = /if\s*\(\s*(?:ev|e)\.target\s*===[\s\S]{0,120}?closeGlobalSearch/.test(search);
    ok(!outsideClose, "没有「点到别处就关」的监听（document / window 级）");
    ok(
      search.indexOf('ev.key === "Escape"') > 0 && search.indexOf("closeBtn.onclick") > 0,
      "关闭只走显式路径：Esc / ✕",
    );
    ok(search.indexOf("layer.hidden = !layer.hidden") < 0, "不靠 toggle 隐藏，避免状态漂移");
    /* 专注遮罩：呼出即暗化其余界面；只有遮罩本体吃点击（= 无输入的空白），
       所以点它关闭不算「点外部即关」，搜索框里的输入不受影响 */
    ok(search.indexOf("gs-scrim") > 0 && search.indexOf("scrim.onclick") > 0, "专注遮罩：点遮罩本体关闭浮层");
    ok(
      css.indexOf(".gs-scrim") > 0 &&
        /\.gs-scrim\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--bg\)/.test(css) &&
        /\.gs-layer\.on \.gs-scrim/.test(css),
      "遮罩用主题底色（--bg）半透明暗化其余界面，随浅色主题自动跟随",
    );
    ok(
      /\.gs-box\s*\{[^}]*background:\s*var\(--panel\)/.test(css),
      "搜索框本体走主题变量 --panel（不再写死深色）",
    );
    ok(
      !/\.gs-layer\s*\{[^}]*background:\s*transparent/.test(css),
      "浮层层本身不再透明，透出遮罩",
    );
  }

  console.log("\n[7] 真跑：分词 / AND 命中 / 片段 / 分类排序");
  {
    const sb = {
      console,
      window: {},
      document: {
        createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
        getElementById: () => null,
        querySelector: () => null,
        addEventListener: () => {},
      },
      I18n: { t: (s) => s, getLocale: () => "zh" },
      S: {},
      requestAnimationFrame: (fn) => fn(),
      setTimeout,
      clearTimeout,
    };
    vm.createContext(sb);
    const api = vm.runInContext(
      search +
        "\n;({ terms: gsTerms, hit: gsHit, snip: gsSnippet, sort: gsSortItems, cats: GS_CATS, nodeHit: gsNodeHit, GS: GS })",
      sb,
    );

    ok(show(api.terms("Hello 世界")) === show(["hello", "世界"]), "分词：大小写归一 + 空格切词");
    ok(api.hit("Hello World", ["hello", "world"]) >= 0, "AND：两个词都命中才算命中");
    ok(api.hit("Hello", ["hello", "world"]) === -1, "AND：缺一词即不命中");
    ok(api.hit("abc", []) === -1, "空词表不命中");
    const long = "前缀".repeat(80) + "命中词" + "后缀".repeat(80);
    const sn = api.snip(long, ["命中词"], 40);
    ok(sn.length <= 42 && sn.indexOf("命中词") >= 0 && sn.indexOf("…") >= 0, "片段围绕命中词截取并补省略号");

    const n = { title: "文本节点", text: "正文里的关键词", output: { text: "结果里的关键词" } };
    const h1 = api.nodeHit(n, ["文本"]);
    const h2 = api.nodeHit(n, ["结果"]);
    ok(h1 && h1.score === 3, "标题命中给最高分（score=3）");
    ok(h2 && h2.score === 1, "运行结果命中给最低分（score=1，排在标题命中之后）");

    api.GS.items = [
      { cat: "doc", score: 3, title: "d1" },
      { cat: "canvas", score: 1, title: "c1" },
      { cat: "canvas", score: 3, title: "c2" },
      { cat: "canvas", score: 3, title: "c3" },
    ];
    api.sort();
    ok(
      show(api.GS.items.map((x) => x.title)) === show(["c2", "c3", "c1", "d1"]),
      "排序：先按分类清单顺序、类内按分数降序（同分保持收集序）：" + show(api.GS.items.map((x) => x.title)),
    );
    ok(
      show(api.cats.map((c) => c.id)) === show(["canvas", "session", "team", "asset", "tool", "skill", "tpl", "doc"]),
      "分类顺序：画布 → 会话 → 专家团 → 素材 → 工具 → 技能 → 模板 → 文档",
    );
  }

  console.log("\n[8] 真跑：结果定位的画布切换（前台真源口径 + 收掉盖住的浮窗）");
  const gotoChecks = (() => {
    /* 沙箱里只钉定位这一段：S.wf 与 currentVisibleWf（前台真源）可以故意不同步，
       模拟后台换画布编辑（runAgainstWf）期间点搜索结果的两种情况。 */
    function makeGotoSandbox(state) {
      const rec = [];
      const S = { view: state.view || "agent", wf: state.swf, _fgWf: state.fgw };
      const sb = {
        console,
        setTimeout,
        clearTimeout,
        window: {},
        document: {
          createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
          getElementById: () => (state.assetOpen ? { classList: { contains: () => true } } : null),
          querySelector: () => null,
          addEventListener: () => {},
        },
        I18n: { t: (s) => s, getLocale: () => "zh", listJoin: (a) => (a || []).join("、") },
        S,
        requestAnimationFrame: (fn) => fn(),
        currentVisibleWf: () => S._fgWf,
        setView: (v) => { rec.push("setView:" + v); S.view = v; },
        /* 忠实模拟真 loadWorkflow 的两条语义：① 目标已是 S.wf → 直接返回（前台没动）；
           ② 否则真切过去（换 S.wf 与前台真源） */
        loadWorkflow: async (id) => {
          rec.push("loadWorkflow:" + id);
          if (S.wf && S.wf.id === id) return;
          S.wf = { id };
          S._fgWf = S.wf;
        },
        setForegroundWf: (wf) => { rec.push("setForegroundWf:" + (wf && wf.id)); S._fgWf = wf; S.wf = wf; },
        renderAll: () => rec.push("renderAll"),
        refreshWfSelect: () => rec.push("refreshWfSelect"),
        renderCanvas: () => rec.push("renderCanvas"),
        nodeById: (id) => (id === "n1" ? { id: "n1" } : null),
        focusNode: (id) => rec.push("focusNode:" + id),
        closeOverlay: () => rec.push("closeOverlay"),
        assetLibOpen: () => !!state.assetOpen,
        closeAssetLib: () => rec.push("closeAssetLib"),
        closeAppDocs: () => rec.push("closeAppDocs"),
        closeExtManagerDialog: () => rec.push("closeExtManagerDialog"),
        toast: (m, k) => rec.push("toast:" + k + ":" + m),
        GS: null,
      };
      vm.createContext(sb);
      vm.runInContext(search, sb);
      return { sb, rec, S };
    }
    const run = (state, g) =>
      vm
        .runInContext(
          "(async () => { await gsGotoCanvas(" + JSON.stringify(g) + "); return true; })()",
          state.sb,
        )
        .then(() => state.rec);

    return Promise.all([
      /* ① 常规跨画布：可见 = S.wf = A，点 B → loadWorkflow(B) */
      run(makeGotoSandbox({ swf: { id: "A" }, fgw: { id: "A" } }), { kind: "canvasNode", wfId: "B", nodeId: "n1" }).then(
        (rec) =>
          ok(
            rec.indexOf("loadWorkflow:B") >= 0 && rec.indexOf("setForegroundWf:B") < 0 && rec.indexOf("focusNode:n1") >= 0,
            "常规：A 可见时点 B 的结果 → loadWorkflow(B) 后选中节点：" + show(rec),
          ),
      ),
      /* ② 后台借走 S.wf：S.wf = B（在飞），可见还是 A，点 B 的结果 → 必须补前台切换 */
      run(makeGotoSandbox({ swf: { id: "B" }, fgw: { id: "A" } }), { kind: "canvasNode", wfId: "B", nodeId: "n1" }).then(
        (rec) =>
          ok(
            rec.indexOf("setForegroundWf:B") >= 0 && rec.indexOf("focusNode:n1") >= 0,
            "后台借走 S.wf 时点它的结果：补 setForegroundWf(B) 真切过去（不再静默不动）：" + show(rec),
          ),
      ),
      /* ③ 目标就是可见画布，但 S.wf 被借走：不重读盘，指回前台真源再定位 */
      run(makeGotoSandbox({ swf: { id: "B" }, fgw: { id: "A" } }), { kind: "canvasNode", wfId: "A", nodeId: "n1" }).then(
        (rec) =>
          ok(
            rec.indexOf("loadWorkflow") < 0 &&
              rec.indexOf("setForegroundWf:A") >= 0 &&
              rec.indexOf("focusNode:n1") >= 0,
            "目标已是可见画布、S.wf 被借走：不重读盘，指回前台真源再定位：" + show(rec),
          ),
      ),
      /* ④ 节点不在目标画布：给提示，不静默 */
      run(makeGotoSandbox({ swf: { id: "A" }, fgw: { id: "A" } }), { kind: "canvasNode", wfId: "A", nodeId: "zz" }).then(
        (rec) =>
          ok(
            rec.some((x) => x.indexOf("toast:warn:节点不在当前画布") === 0) && rec.indexOf("focusNode:zz") < 0,
            "切过去后节点仍不在该画布：提示而不是静默：" + show(rec),
          ),
      ),
      /* ⑤ 素材库开着时定位画布结果：先收掉挡着的那层，再切画布 */
      run(makeGotoSandbox({ swf: { id: "A" }, fgw: { id: "A" }, assetOpen: true }), {
        kind: "canvasNode",
        wfId: "B",
        nodeId: "n1",
      }).then((rec) =>
        ok(
          rec.indexOf("closeAssetLib") >= 0 &&
            rec.indexOf("closeOverlay") >= 0 &&
            rec.indexOf("closeAssetLib") < rec.indexOf("loadWorkflow:B"),
          "定位前先收掉盖住画面的浮窗（素材库 / #overlay），再切画布：" + show(rec),
        ),
      ),
    ]).then(() => {});
  })();

  console.log("\n[9] 真跑：一轮完整搜索（各区域收集 → 分类分组渲染）");
  {
    /* 极简 DOM 垫片：只实现本模块用到的 appendChild / querySelector / classList / dataset */
    const byId = new Map();
    function makeEl(tag) {
      const el = {
        tagName: String(tag || "div").toUpperCase(),
        children: [],
        style: {},
        dataset: {},
        hidden: false,
        placeholder: "",
        title: "",
        type: "",
        _text: "",
        _html: "",
        _cls: new Set(),
        _q: {},
        classList: {
          add(...c) {
            c.forEach((x) => el._cls.add(x));
          },
          remove(...c) {
            c.forEach((x) => el._cls.delete(x));
          },
          toggle(c, on) {
            if (on) el._cls.add(c);
            else el._cls.delete(c);
          },
          contains(c) {
            return el._cls.has(c);
          },
        },
        appendChild(c) {
          el.children.push(c);
          return c;
        },
        append(...cs) {
          cs.forEach((c) => el.appendChild(c));
        },
        addEventListener() {},
        removeEventListener() {},
        querySelector(sel) {
          if (!el._q[sel]) el._q[sel] = makeEl("div");
          return el._q[sel];
        },
        querySelectorAll(sel) {
          const want = String(sel).replace(/^\./, "").split("[")[0];
          const out = [];
          const walk = (node) => {
            for (const c of node.children) {
              if (String(c.className || "").split(/\s+/).indexOf(want) >= 0) out.push(c);
              walk(c);
            }
          };
          walk(el);
          return out;
        },
        scrollIntoView() {},
        focus() {},
        select() {},
        get textContent() {
          return el._text + el.children.map((c) => c.textContent).join(" ");
        },
        set textContent(v) {
          el._text = String(v);
          el.children = [];
        },
        get innerHTML() {
          return el._html;
        },
        set innerHTML(v) {
          el._html = String(v);
          el.children = [];
          el._text = "";
        },
      };
      Object.defineProperty(el, "className", {
        get() {
          return Array.from(el._cls).join(" ");
        },
        set(v) {
          el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
        },
      });
      return el;
    }
    const documentStub = {
      body: makeEl("body"),
      createElement: (t) => makeEl(t),
      createTextNode: (t) => ({ textContent: String(t), children: [] }),
      getElementById(id) {
        if (!byId.has(id)) byId.set(id, makeEl("div"));
        return byId.get(id);
      },
      querySelector: () => null,
      addEventListener() {},
    };

    const wf = {
      id: "w1",
      name: "我的画布",
      nodes: [
        { id: "n1", kind: "input_text", title: "文本节点", text: "正文里有 关键词 出现" },
        { id: "n2", kind: "proc_text", title: "生成器", prompt: "无关内容" },
      ],
      marks: [{ id: "m1", kind: "text", text: "便签：关键词 在这里" }],
    };
    const wf2 = { id: "w2", name: "第二章", nodes: [], marks: [] };
    const api = {
      wfList: async () => [
        { id: "w1", name: "我的画布", mtime: 1 },
        { id: "w2", name: "第二章", mtime: 2 },
      ],
      wfLoad: async (id) => ({ ok: true, data: id === "w1" ? wf : wf2 }),
      assetsScan: async () => ({
        ok: true,
        configured: true,
        scan: {
          assets: [
            {
              id: "a1",
              displayName: "关键词素材",
              folder: "素材夹",
              catRel: "素材夹",
              items: [{ id: "i1", title: "关键词文本条目", type: "text", absPath: "E:/lib/i1.md", bytes: 20 }],
            },
          ],
        },
      }),
      fileReadText: async () => "文件正文里也有关键词",
      toolsList: async () => ({ ok: true, tools: [{ id: "t1", name: "关键词工具", description: "做点事" }] }),
      skillList: async () => ({ skills: [{ name: "my-skill", title: "关键词技能", description: "写点东西" }] }),
      mtnodeAgentSkillIndex: async () => ({
        ok: true,
        index: {
          categories: [
            {
              id: "mtnode",
              title: "MTNode 产品与画布",
              skills: [
                { id: "canvas-edit-rules", name: "mtnode-canvas-edit-rules", title: "内置关键词技能", description: "画布硬规则" },
              ],
            },
          ],
        },
      }),
      docsCatalog: async () => ({
        ok: true,
        catalog: { sections: [{ id: "s", title: { zh: "入门" }, pages: [{ id: "p1", title: { zh: "关键词手册页" } }] }] },
      }),
      docsLoad: async () => ({ ok: true, markdown: "手册正文里有关键词" }),
      guideLoad: async (id) => ({ ok: true, markdown: id === "proc_text" ? "节点指南里有关键词" : "无关内容" }),
      storeRequest: () => null,
    };

    const sb = {
      console,
      setTimeout,
      clearTimeout,
      window: { api },
      document: documentStub,
      requestAnimationFrame: (fn) => fn(),
      I18n: { t: (s) => s, getLocale: () => "zh", listJoin: (a) => (a || []).join("、") },
      S: {
        wf: wf,
        view: "workflow",
        agentSessions: [
          {
            id: "s1",
            title: "会话甲",
            messages: [{ role: "user", content: "提问里有关键词" }],
          },
        ],
      },
      agentSessions: () => sb.S.agentSessions,
      teamChats: () => [
        {
          id: "c1",
          title: "专家会话乙",
          expertId: "e1",
          canvasId: "w1",
          messages: [{ role: "assistant", content: "专家回答里有关键词" }],
        },
      ],
      teamExperts: () => [{ id: "e1", name: "关键词专家", role: "顾问", canvasId: "w1" }],
      loadSkillsCached: async () => [{ name: "关键词技能", description: "写点东西" }],
      toast: () => {},
      setView: () => {},
      loadWorkflow: async () => {},
      focusNode: () => {},
    };
    vm.createContext(sb);
    const run = vm.runInContext(
      search +
        "\n;(async () => {" +
        '  GS.query = "关键词";' +
        "  await gsRun(false);" +
        "  const cats = {};" +
        "  for (const it of GS.items) cats[it.cat] = (cats[it.cat] || 0) + 1;" +
        "  const host = document.getElementById('gsResults');" +
        "  const heads = Array.from(host.querySelectorAll('.gs-cat')).map((h) => h.textContent);" +
        "  const rows = host.querySelectorAll('.gs-row').length;" +
        "  const tabsEl = document.getElementById('gsTabs');" +
        "  const tabs = Array.from(tabsEl.children).map((b) => b.textContent);" +
        "  const tabIds = Array.from(tabsEl.children).map((b) => b.dataset.gsTab);" +
        "  const tabsHidden = tabsEl.hidden;" +
        '  GS.tab = "session";' +
        "  gsRender();" +
        "  const sHeads = host.querySelectorAll('.gs-cat').length;" +
        "  const sRows = host.querySelectorAll('.gs-row').length;" +
        '  GS.tab = "all";' +
        "  gsRender();" +
        "  return { cats: cats, heads: heads, rows: rows, tabs: tabs, tabIds: tabIds, tabsHidden: tabsHidden, sHeads: sHeads, sRows: sRows, titles: GS.items.map((i) => i.cat + '|' + i.title) };" +
        "})()",
      sb,
    );
    return Promise.all([run, gotoChecks]).then(([r]) => {
      ok(r.cats.canvas >= 2, "画布：命中节点正文与标注（" + r.cats.canvas + " 条）");
      ok(r.cats.session >= 1, "会话：命中消息正文（" + r.cats.session + " 条）");
      ok(r.cats.team >= 2, "专家团：命中专家名与会话消息（" + r.cats.team + " 条）");
      ok(r.cats.asset >= 3, "素材：命中素材名 / 条目名 / 文件正文（" + r.cats.asset + " 条）");
      ok(r.cats.tool >= 1, "工具库：命中工具名（" + r.cats.tool + " 条）");
      ok(r.cats.skill >= 2, "技能：本机技能与内置技能索引都参与（" + r.cats.skill + " 条）");
      ok(r.cats.doc >= 3, "手册文档：命中手册页标题 / 正文与节点指南正文（" + r.cats.doc + " 条）");
      ok(r.cats.tpl === undefined, "模板商店离线时静默跳过，不产生空分类");
      const expectRows = Object.keys(r.cats).reduce((n, k) => n + Math.min(20, r.cats[k]), 0);
      ok(r.rows === expectRows && r.rows > 0, "结果行渲染数=各类前 20 条之和（" + r.rows + " 行）");
      const labels = ["画布（跨画布）", "会话记录", "专家团", "素材库与本机文件", "工具库", "技能", "手册文档"];
      const at = labels.map((L) => r.heads.findIndex((h) => h.indexOf(L) === 0));
      ok(
        at.every((i) => i >= 0) && at.every((i, k) => k === 0 || at[k - 1] < i),
        "分类标题按固定顺序出现：" + show(r.heads),
      );
      ok(
        r.titles.some((t) => t === "canvas|文本节点") && r.titles.some((t) => t.indexOf("canvas|便签：关键词") === 0),
        "跨画布：节点正文命中给字段标签、标注各自成行：" + show(r.titles.filter((t) => t.indexOf("canvas|") === 0)),
      );
      ok(
        r.titles.indexOf("session|会话甲") >= 0 && r.titles.indexOf("team|专家会话乙") >= 0,
        "会话与专家团的命中行带上所属标题",
      );
      /* ── 结果分栏 ── */
      ok(!r.tabsHidden && r.tabs.length > 1, "有结果后出现分栏 Tabs（" + r.tabs.length + " 个）");
      ok(r.tabIds[0] === "all" && r.tabs[0].indexOf("全部") === 0, "第一个分栏是「全部」：" + r.tabs[0]);
      ok(
        r.tabIds.length === r.tabs.length && r.tabIds.slice(1).every((id) => !!r.cats[id]),
        "其后每个分栏都对应一个搜到的分类：" + show(r.tabIds),
      );
      ok(
        r.tabIds.slice(1).every((id) => r.tabs[r.tabIds.indexOf(id)].indexOf(String(r.cats[id])) >= 0),
        "每个分类分栏标注该类的条目数：" + show(r.tabs.slice(1)),
      );
      ok(
        r.tabs[0].indexOf(String(Object.keys(r.cats).reduce((n, k) => n + r.cats[k], 0))) >= 0,
        "「全部」分栏标注条目总数：" + r.tabs[0],
      );
      ok(r.sHeads === 1 && r.sRows === Math.min(20, r.cats.session), "切到「会话记录」分栏只渲染该类（" + r.sRows + " 行）");
      console.log(
        "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"),
      );
      if (fails ? 1 : 0) MERGED_FAILED = true;
    });
  }

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-global-search.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-global-search.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

"use strict";
/* ============================================================
 * 会话左栏「DeepSeek Harness」后的 dsh 内核版本号（本次需求）
 * —— 链路级冒烟测试（纯 Node，不依赖 Electron）
 *   node test/smoke-agent-side-version.js
 *
 * 需求：左栏标题「DeepSeek Harness」后面加一枚 dsh 内核版本（例：0.2.1-rc.2）。
 * 被测代码是真实源码，不抄逻辑：
 *   renderer/index.html      #agentLogo 里名称 + 版本标签的结构与顺序
 *   renderer/css/dsh.css     .agent-side-ver 的规则（版本标签永不被截断）
 *   renderer/css/theme-light.css  浅色主题下版本标签可读（深色上是白字，白底会看不见）
 *   renderer/app-boot.js     applyAgentDshVersion 切片真跑：空值整枚隐藏、有值写文本与提示
 *   main.js                  app:version 把 dsh 版本一并回给渲染层
 *   dsh/main-dsh.js          dshKernelVersion 真加载一次（临时 electron 假体）读 manifest
 *   renderer/i18n.js         新增词条中英齐备
 * ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");
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
    .replace(/\r\n?/g, "\n");
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);

const HTML = read("renderer/index.html");
const CSS = read("renderer/css/dsh.css");
const LIGHT = read("renderer/css/theme-light.css");
const BOOT = read("renderer/app-boot.js");
const MAIN = read("main.js");
const DSHMOD = read("dsh/main-dsh.js");
const I18N = read("renderer/i18n.js");

/* ── [1] 左栏标题结构 ─────────────────────────────────────────── */
console.log("\n[1] index.html：左栏标题 = 名称 + dsh 版本标签");
{
  const m = HTML.match(/<span class="agent-side-logo"[^>]*id="agentLogo"[\s\S]*?<\/span><\/span>/);
  const logo = m ? m[0] : "";
  ok(!!logo, "找到 #agentLogo 标题（名称与版本都在同一枚可点标题里）");
  ok(
    /<span class="agent-side-name">DeepSeek Harness<\/span>/.test(logo),
    "标题正文仍是 DeepSeek Harness（包在 .agent-side-name 里，省略号只吃名称）",
  );
  ok(
    /<span class="agent-side-ver"[^>]*id="agentDshVer"[^>]*hidden><\/span>/.test(logo),
    "版本标签 #agentDshVer 紧跟名称之后、默认 hidden（读不到版本就不占位）",
  );
  ok(
    logo.indexOf('id="agentDshVer"') > logo.indexOf("agent-side-name"),
    "版本标签排在名称之后（即「DeepSeek Harness 0.2.1-rc.2」的视觉顺序）",
  );
  ok(
    /id="agentDshVer"[^>]*data-i18n-title="dsh 内核版本"/.test(logo),
    "版本标签带 hover 提示词条「dsh 内核版本」",
  );
  ok(
    /id="agentLogo"[^>]*data-i18n-title="新建会话"/.test(logo) && /id="agentNew"/.test(HTML),
    "标题仍是「新建会话」入口，新建按钮未动",
  );
}

/* ── [2] 样式 ─────────────────────────────────────────────────── */
console.log("\n[2] 样式：宽度够时同行、窄栏换行，名称与版本都不被截断");
{
  const logoRule = (CSS.match(/\.agent-side-logo \{[\s\S]*?\}/) || [""])[0];
  ok(/display: flex/.test(logoRule), ".agent-side-logo 改成 flex（名称 + 版本一枚一行/两行）");
  ok(/align-items: baseline/.test(logoRule), "名称与版本按基线对齐");
  ok(/min-width: 0/.test(logoRule), ".agent-side-logo 允许收缩（否则 flex 子项不肯让位）");
  /* 左栏默认宽度就是最小宽度 280px：一行塞不下名称 + 版本 + 新会话按钮，
     所以在 280 下版本必须能掉到第二行，否则名称会被省略号吃掉（实测过）。 */
  ok(/flex-wrap: wrap/.test(logoRule), "允许换行：280px 下版本掉到名称下面一行，名称保持完整");
  ok(!/text-overflow/.test(logoRule), "省略号不再挂在整枚标题上（那会把版本号一起吃掉）");
  const nameRule = (CSS.match(/\.agent-side-name \{[\s\S]*?\}/) || [""])[0];
  ok(/text-overflow: ellipsis/.test(nameRule) && /overflow: hidden/.test(nameRule), ".agent-side-name 自己吃省略号");
  const verRule = (CSS.match(/\.agent-side-ver \{[\s\S]*?\}/) || [""])[0];
  ok(!!verRule, ".agent-side-ver 有独立规则");
  ok(/flex: none/.test(verRule), "版本标签 flex:none（永不压缩、永不被截断）");
  ok(/font-size: 10\.5px/.test(verRule), "版本标签比标题小一号（10.5px）");
  ok(/border-radius: 6px/.test(verRule) && /border: 1px solid/.test(verRule), "版本标签是小胶囊（圆角 + 细边）");
  ok(
    /body\.theme-light \.agent-side-ver \{[\s\S]*?\}/.test(LIGHT) &&
      /color: rgba\(24, 26, 30/.test(LIGHT),
    "浅色主题给了版本标签的深色字覆盖（否则白字压白底看不见）",
  );
}

/* ── [3] applyAgentDshVersion 真跑（切片） ─────────────────────── */
console.log("\n[3] renderer：applyAgentDshVersion 切片真跑");
{
  const src = (BOOT.match(/function applyAgentDshVersion\(v\) \{[\s\S]*?\n\}/) || [""])[0];
  ok(!!src, "app-boot.js 有 applyAgentDshVersion");
  ok(
    /applyAgentDshVersion\(vr && vr\.ok \? vr\.dsh : ""\)/.test(BOOT),
    "启动链路把 app:version 的 dsh 字段交给它（拿不到就空串）",
  );
  const run = (val) => {
    const el = { textContent: "残留", hidden: false, title: "" };
    const sandbox = {
      $: () => el,
      I18n: { t: (s) => s },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(src + "\napplyAgentDshVersion(" + JSON.stringify(val) + ");", sandbox);
    return el;
  };
  const empty = run("");
  ok(empty.hidden === true, "空串 → 整枚标签 hidden（不占位、不写「未知」）");
  ok(empty.textContent === "", "空串 → 文本也清空（不留上一帧残值）");
  const undef = run(undefined);
  ok(undef.hidden === true, "undefined（老主进程没这个字段）→ 一样隐藏");
  const real = run("0.2.1-rc.2");
  ok(real.hidden === false, "有版本 → 显示");
  ok(real.textContent === "0.2.1-rc.2", "文本就是版本号本身（0.2.1-rc.2）");
  ok(/dsh 内核版本 0\.2\.1-rc\.2/.test(real.title), "hover 提示写明「dsh 内核版本 + 版本号」");
}

/* ── [4] 主进程链路：版本从哪来 ────────────────────────────────── */
console.log("\n[4] 主进程：app:version 带 dsh 版本，真源是 @deepseek-ai/dsh 的 manifest");
{
  ok(
    /ipcMain\.handle\("app:version", \(\) => \(\{ ok: true, version: appVersion\(\), dsh: dshKernelVersion\(\) \}\)\)/.test(MAIN),
    "app:version 回 { version, dsh }（与已装应用版本同一跳，不额外起网关）",
  );
  ok(
    /require\("\.\/dsh\/main-dsh\.js"\)/.test(MAIN) && /dshKernelVersion/.test(MAIN),
    "main.js 从 dsh/main-dsh.js 取 dshKernelVersion（路径知识只留在 dsh/ 目录里）",
  );
  ok(/module\.exports = \{ createDshAdapter, GATEWAY_PATH, dshKernelVersion \}/.test(DSHMOD), "main-dsh 导出 dshKernelVersion");
  ok(
    /path\.join\(path\.dirname\(GATEWAY_PATH\), 'node_modules', '@deepseek-ai', 'dsh', 'package\.json'\)/.test(DSHMOD),
    "版本从网关树里的 @deepseek-ai/dsh/package.json 读（dev / 打包同一处推导）",
  );
  ok(/catch \{ \/\* 依赖还没装 \/ 打包缺包：留空 \*\/ \}/.test(DSHMOD), "读不到就留空，绝不编版本号");

  /* 真加载一次：临时 electron 假体（只用到 app.isPackaged），版本必须等于磁盘上的 manifest */
  const manifest = path.join(__dirname, "..", "dsh", "gateway", "node_modules", "@deepseek-ai", "dsh", "package.json");
  const want = fs.existsSync(manifest) ? String(JSON.parse(fs.readFileSync(manifest, "utf8")).version || "") : "";
  const Module = require("module");
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === "electron")
      return {
        app: {
          isPackaged: false,
          getAppPath: () => path.join(__dirname, ".."),
          getPath: () => os.tmpdir(),
          getVersion: () => "39.0.0",
        },
      };
    return origLoad.apply(this, arguments);
  };
  let got = "";
  try {
    const mod = require(path.join(__dirname, "..", "dsh", "main-dsh.js"));
    got = mod.dshKernelVersion();
  } finally {
    Module._load = origLoad;
  }
  ok(/^\d+\.\d+\.\d+/.test(want), "本机网关树里 @deepseek-ai/dsh 的版本可读（" + (want || "读不到") + "）");
  ok(got === want, "dshKernelVersion() 读到的就是 manifest 版本（实际=" + JSON.stringify(got) + "）");
}

/* ── [5] 词条 ─────────────────────────────────────────────────── */
console.log("\n[5] i18n：新词条中英齐备");
{
  HAS(I18N, '"dsh 内核版本": "dsh kernel version"', "「dsh 内核版本」有英文词条");
  HAS(I18N, "dsh 内核版本", "中文键在 EN 表里（渲染层 t() 才命中）");
}

console.log("\n" + (fails ? "FAILED " : "PASS ") + (checks - fails) + "/" + checks);
process.exit(fails ? 1 : 0);

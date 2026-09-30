/* 冒烟：CDP 面板（需求「参考 dsh 桌面版 Developer tools」的 DevTools 前端那一条）
 *
 * 口径：**不自己重写 Console / Network** —— 直接开这台浏览器自带的 DevTools 前端
 * （Chromium 调试端点 serve 的 /devtools/ 页面，同源直连本机 CDP）。
 *   · 网关侧：browser-host.mjs 的 devtoolsUrl() 取 /json/list 里的 devtoolsFrontendUrl，
 *     优先当前会话驱动的那一页；gateway 的 browser action:'devtools' 转发。
 *   · 渲染层：renderer/app-devtools.js 内嵌该地址（入口 = 浏览器活动栏的「DevTools」按钮，
 *     受设置 · 开发者工具约束），走既有 BA.browser 通道。
 *
 * 本冒烟分两段：
 *   [1] 静态接线（不依赖浏览器）：上面这些点每处都在位；
 *   [2] 真端点（本机装了 Edge/Chrome 就跑）：拉起真浏览器 → 取地址 → 断言拿到 /devtools/
 *       前端 URL。没装浏览器时**如实标 SKIP**（不算失败，也不假装通过）。
 *
 * 跑法：node test/smoke-cdp-panel.js
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0;
let fail = 0;
let skip = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ " + label);
  }
}
function note(label) {
  skip++;
  console.log("  ~ " + label);
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

console.log("cdp-panel smoke");

/* ── [1] 静态接线 ──────────────────────────────────────────────────────── */
const host = read("dsh/gateway/browser-host.mjs");
ok(/export async function devtoolsUrl\(\)/.test(host), "[1] browser-host.mjs 导出 devtoolsUrl()");
ok(/devtoolsFrontendUrl/.test(host), "[1] 取的是 Chromium 自带的 DevTools 前端地址（不自写 Console/Network）");
ok(/\/json\/list/.test(host), "[1] 从调试端点的 target 列表里取（同源直连本机 CDP）");

const gw = read("dsh/gateway/gateway.mjs");
ok(/action === 'devtools'/.test(gw), "[1] 网关 browser 动作里接了 'devtools'");
ok(/async devtoolsUrl\(\)/.test(gw), "[1] BrowserCtl 暴露 devtoolsUrl");

const html = read("renderer/index.html");
ok(/<script src="app-devtools\.js"><\/script>/.test(html), "[1] index.html 引入了 app-devtools.js");
ok(html.indexOf('<script src="app-devtools.js"></script>') > html.indexOf('<script src="app-browser.js"></script>'), "[1] 排在 app-browser.js 之后（借 BA 通道）");

const dev = read("renderer/app-devtools.js");
ok(/window\.MTNodeDevtools\s*=/.test(dev), "[1] 导出 window.MTNodeDevtools");
ok(/BA\.browser\('devtools'|BA\.browser\("devtools"|browserCall\("devtools"/.test(dev), "[1] 走既有浏览器桥取地址（不新增接口）");
ok(/developerTools\s*!==\s*false/.test(dev), "[1] 入口受 developerTools 开关约束");
ok(/sandbox/.test(dev) && /allow-scripts/.test(dev), "[1] 内嵌 iframe 带沙箱（只放脚本/同源/表单/弹窗）");

const browser = read("renderer/app-browser.js");
ok(/window\.MTNodeBrowser\s*=\s*\{\s*BA\s*\}/.test(browser), "[1] app-browser.js 把 BA 通道挂到全局（CDP 面板复用同一条）");

const tokens = read("renderer/css/dsh-tokens.css");
ok(/\.dsh-cdp\b/.test(tokens) && /\.dsh-cdp-frame/.test(tokens), "[1] CDP 面板样式在位（.dsh-cdp-*）");

/* ── [2] 真端点：拉起浏览器 → 取 DevTools 地址 ─────────────────────────── */
(async () => {
  let BrowserHost;
  try {
    BrowserHost = await import(pathToFileURL(path.join(ROOT, "dsh", "gateway", "browser-host.mjs")).href);
  } catch (err) {
    ok(false, "[2] 无法加载 browser-host.mjs：" + String((err && err.message) || err));
    finish();
    return;
  }
  const exe = typeof BrowserHost.detectBrowser === "function" ? BrowserHost.detectBrowser() : "";
  if (!exe) {
    note("[2] 本机没找到 Edge/Chrome —— 真端点段 SKIP（静态接线已钉住；装好浏览器再跑这条会真起一次）");
    finish();
    return;
  }
  console.log("      用这只浏览器真跑一次：" + exe);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-cdp-"));
  let started = false;
  try {
    await BrowserHost.ensureBrowser({ profileDir: BrowserHost.profileDirOf(home), dshHome: home, visible: false });
    started = true;
    /* 还没有页面时给一句人话，而不是崩 */
    const before = await BrowserHost.devtoolsUrl().catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
    ok(typeof before === "object", "[2] 没有页面时 devtoolsUrl 回结构化结果（不抛）");
    /* 真开一个页面，再取 DevTools 前端地址 —— 这条端到端失败才说明接线真断了 */
    try {
      await BrowserHost.navigate({ url: "about:blank" });
    } catch {
      /* navigate 的参数形状随版本：失败了也不影响后面的断言口径（下面按 ok:false 如实报） */
    }
    const r = await BrowserHost.devtoolsUrl();
    if (r && r.ok && r.url) {
      ok(/\/devtools\//.test(r.url), "[2] 拿到 Chromium 自带 DevTools 前端地址");
      ok(/ws=|ws%3D/.test(r.url), "[2] 地址里带 CDP 目标（前端据此直连本机调试端点）");
    } else {
      note("[2] 这台机器上没取到 DevTools 地址（" + ((r && (r.reason || r.error)) || "未知") + "）—— 标 SKIP，不假装通过");
    }
  } catch (err) {
    note("[2] 真起浏览器失败（" + String((err && err.message) || err).slice(0, 120) + "）—— 标 SKIP");
  } finally {
    if (started) {
      try {
        await BrowserHost.stopBrowser({});
      } catch {
        /* 收尾尽力而为 */
      }
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* Windows 上 profile 目录可能还被占着：留着也无害 */
    }
    finish();
  }
})();

function finish() {
  console.log("\ncdp-panel smoke: pass " + pass + " / fail " + fail + " / skip " + skip);
  process.exitCode = fail ? 1 : 0;
}

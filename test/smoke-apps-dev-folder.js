"use strict";
/* test/smoke-apps-dev-folder.js — 渲染层回归
 *   本轮需求：应用开发页「预览」列头上多一枚「📂 应用文件夹」按钮 —— 点它在系统资源管理器里
 *   打开**当前应用的文件夹**（应用目录：入口页 index.html / app.json 所在的那个）。
 *
 *   ① 源码接线：按钮挂在哪个容器（.apps-dev-colhead，预览列头）· 常驻不藏 · 走通用出口
 *      window.api.shellOpenPath（不新增 IPC）· 路径只从主进程解析的两条链取（应用摘要 dir →
 *      预览 info dir），渲染层不拼路径；
 *   ② vm 真跑 appsDevOpenAppFolder：目录命中 → 打开那一个；摘要还没有 → 回落到预览 info 的 dir；
 *      没选应用 / 两条链都拿不到 → 只提示不开；主进程回 ok:false / 抛错 → 弹失败 toast（不静默）；
 *   ③ 样式与词条：.apps-dev-folderbtn 存在且不撑高标题条、URL 是唯一的弹性项、英文词条齐备。
 *
 * 口径：零依赖、不启动 Electron、不碰真实 %APPDATA%、不写任何文件。
 *
 * 运行：node test/smoke-apps-dev-folder.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
let checks = 0;
let fails = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const section = (t) => console.log("\n[" + t + "]");

/* 从源码里原样切出一个函数（按大括号配平；字符串与模板串里的括号不算）。
   async 前缀一起带上 —— 少了它 vm 里一遇 await 就 SyntaxError。 */
function pickFn(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("切不出函数：" + name);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  let depth = 0;
  let str = "";
  let started = false;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (str) {
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === str) str = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      str = c;
      continue;
    }
    if (c === "{") {
      depth++;
      started = true;
      continue;
    }
    if (c === "}") {
      depth--;
      if (started && depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error("括起来没配平：" + name);
}

const DEV = read("renderer/app-apps-dev.js");
const APPS = read("renderer/app-apps.js");
const I18N = read("renderer/i18n.js");
const CSS = read("renderer/css/apps.css");
const PRELOAD = read("preload.js");

console.log(
  "smoke-apps-dev-folder：预览列头「📂 应用文件夹」按钮（点它进当前应用的文件夹）\n",
);

/* ═══════════ [1] 源码接线：按钮挂在预览列头，常驻不藏 ═══════════ */
section("1 接线点");
{
  /* 预览列头 = app-apps-dev.js 里那只 .apps-dev-colhead（左「预览」+ URL + 右端按钮） */
  const headFn = pickFn(DEV, "appsDevFolderBtnEl");
  ok(headFn.indexOf("appsMiniBtn(") >= 0, "按钮用既有的 appsMiniBtn 造（样式与工具栏同一套）");
  ok(
    headFn.indexOf('appsDevT("📂 应用文件夹")') >= 0,
    "按钮文案 = 📂 应用文件夹（有字有图标，一眼看出是进文件夹）",
  );
  ok(
    /b\.title\s*=/.test(headFn) && /setAttribute\("aria-label"/.test(headFn),
    "title 与 aria-label 都给了（悬浮说明 + 无障碍）",
  );
  ok(
    headFn.indexOf("appsDevOpenAppFolder()") >= 0,
    "点击出口 = appsDevOpenAppFolder（路径解析与打开的单一实现）",
  );
  ok(
    /viewHead\.appendChild\(appsDevFolderBtnEl\(\)\);/.test(DEV),
    "按钮 append 进预览列头（viewHead = .apps-dev-colhead）",
  );
  ok(
    DEV.split("appsDevFolderBtnEl()").length - 1 === 2,
    "整份模块里只在定义与挂载两处出现（没有第二处重复入口）",
  );
  ok(
    /viewHead\.appendChild\(bridgeCloseBtn\);[\s\S]{0,400}viewHead\.appendChild\(appsDevFolderBtnEl\(\)\);/.test(
      DEV,
    ),
    "紧跟「关掉独立窗口」之后挂（预览列头右端那一组）",
  );
  ok(
    DEV.indexOf("folderBtn.hidden") < 0 && !/apps-dev-folderbtn[\s\S]{0,80}hidden = true/.test(DEV),
    "常驻不藏：没选中应用时也看得见（点了给一句提示，而不是按钮凭空消失）",
  );
}

/* ═══════════ [2] 源码接线：路径真源与打开出口 ═══════════ */
section("2 路径真源 / 打开出口");
{
  const openSrc = pickFn(DEV, "appsDevOpenAppFolder");
  ok(
    openSrc.indexOf("appsDevProjectDir(id)") >= 0,
    "① 先取应用摘要里的 dir（apps-store 解析好的绝对路径，渲染层不拼）",
  );
  ok(
    /const info = await appsDevPreviewInfo\(\);/.test(openSrc) &&
      /info && info\.dir/.test(openSrc),
    "② 摘要还没回来时回落到预览 info 的 dir（apps:devPreview 同一个 previewDirOf 解析）",
  );
  ok(
    openSrc.indexOf("if (!dir) {") >= 0 && openSrc.indexOf("return;") >= 0,
    "两条链都拿不到 → 明确提示并返回（绝不去猜一个路径打开）",
  );
  ok(
    /window\.api\s*\|\|\s*\{\}|api\.shellOpenPath\(dir\)/.test(openSrc) &&
      openSrc.indexOf("shellOpenPath") >= 0,
    "打开走通用出口 window.api.shellOpenPath（主进程 shell:openPath → shell.openPath）",
  );
  ok(
    openSrc.indexOf("r.ok === false") >= 0 && openSrc.indexOf("catch (e)") >= 0,
    "主进程回失败 / 调用抛错都弹 toast（不静默吞掉）",
  );
  ok(
    PRELOAD.indexOf("shellOpenPath:") >= 0 && PRELOAD.indexOf("'shell:openPath'") >= 0,
    "preload 早就白名单了这个出口（本轮不新增 IPC）",
  );
  ok(
    pickFn(DEV, "appsDevProjectDir").indexOf("appsLocalById") >= 0,
    "appsDevProjectDir 仍从 appsLocalById 的 dir 取（全局唯一取数点）",
  );
  /* 顺带钉住：这条新链没有另造一份 IPC / 桥名 */
  ok(
    DEV.indexOf("appsOpenFolder") < 0 && DEV.indexOf("appsFolderOpen") < 0,
    "没有另造 apps:xxxFolder 这类新通道（复用既有 shell 出口）",
  );
}

/* ═══════════ [3] vm 真跑：appsDevOpenAppFolder 五条路径 ═══════════ */
(async () => {
  section("3 vm 真跑（真代码，不是抄一份）");

  const APP_DIR = path.join("E:", "apps-dev", "appA");
  const PREVIEW_DIR = path.join("E:", "apps-dev", "appA-from-preview");

  function sandbox(opts) {
    const o = opts || {};
    const toasts = [];
    const opened = [];
    const sb = {
      console: console,
      DEVD: { appId: o.appId === undefined ? "appA" : o.appId },
      appsLocalById: () =>
        o.summaryDir === undefined
          ? { id: "appA", dir: APP_DIR, dev: true }
          : o.summaryDir
            ? { id: "appA", dir: o.summaryDir, dev: true }
            : null,
      appsDevT: (s) => String(s == null ? "" : s),
      appsDevToast: (msg, kind) => toasts.push({ msg: msg, kind: kind || "ok" }),
      appsDevPreviewInfo: async () =>
        o.info === undefined ? { ok: true, dir: PREVIEW_DIR } : o.info,
      window: {
        api: {
          shellOpenPath: async (p) => {
            opened.push(p);
            if (o.openThrows) throw new Error("boom");
            return o.openResult === undefined ? { ok: true } : o.openResult;
          },
        },
      },
    };
    vm.createContext(sb);
    vm.runInContext(
      pickFn(DEV, "appsDevOpenAppFolder") +
        "\n" +
        pickFn(DEV, "appsDevProjectDir"),
      sb,
    );
    return {
      sb: sb,
      toasts: toasts,
      opened: opened,
      run: () => vm.runInContext("appsDevOpenAppFolder", sb)(),
    };
  }

  {
    /* 3.1 摘要命中：打开摘要那个 dir，成功 toast 里带路径 */
    const s = sandbox({});
    await s.run();
    ok(s.opened.length === 1 && s.opened[0] === APP_DIR, "摘要命中 → 打开应用目录：" + s.opened[0]);
    ok(
      s.toasts.length === 1 &&
        s.toasts[0].kind === "ok" &&
        s.toasts[0].msg.indexOf(APP_DIR) >= 0,
      "成功给一句带路径的 toast（用户看得见进了哪个文件夹）",
    );
  }
  {
    /* 3.2 摘要还没回来（null）→ 回落预览 info 的 dir */
    const s = sandbox({ summaryDir: null });
    await s.run();
    ok(
      s.opened.length === 1 && s.opened[0] === PREVIEW_DIR,
      "摘要取不到 → 用预览 info 的 dir 打开：" + s.opened[0],
    );
  }
  {
    /* 3.3 摘要 dir 是空串 → 同样回落 */
    const s = sandbox({ summaryDir: "" });
    await s.run();
    ok(s.opened.length === 1 && s.opened[0] === PREVIEW_DIR, "摘要 dir 为空串也回落预览 info");
  }
  {
    /* 3.4 两条链都拿不到 → 不开、只提示 */
    const s = sandbox({ summaryDir: null, info: { ok: false, error: "missing" } });
    await s.run();
    ok(s.opened.length === 0, "读不到应用文件夹 → 一个路径都不打开（不猜）");
    ok(
      s.toasts.length === 1 && s.toasts[0].kind === "warn",
      "给一句 warn 提示：" + (s.toasts[0] && s.toasts[0].msg),
    );
  }
  {
    /* 3.5 没选应用 → 提示，不碰桥 */
    const s = sandbox({ appId: "" });
    await s.run();
    ok(s.opened.length === 0 && s.toasts.length === 1 && s.toasts[0].kind === "warn",
      "没选中应用 → 只提示「先在左栏选一个应用」");
  }
  {
    /* 3.6 主进程回 ok:false → err toast，带上原因 */
    const s = sandbox({ openResult: { ok: false, error: "EPERM" } });
    await s.run();
    ok(
      s.toasts.length === 1 &&
        s.toasts[0].kind === "err" &&
        s.toasts[0].msg.indexOf("EPERM") >= 0,
      "打开失败 → err toast 带主进程给的原因",
    );
  }
  {
    /* 3.7 调用抛错 → 同样兜住 */
    const s = sandbox({ openThrows: true });
    await s.run();
    ok(
      s.toasts.length === 1 && s.toasts[0].kind === "err" && s.toasts[0].msg.indexOf("boom") >= 0,
      "桥抛错 → err toast 带异常消息（不冒泡成未捕获异常）",
    );
  }
  {
    /* 3.8 宿主桥未就绪 → 提示，不抛 */
    const s = sandbox({});
    s.sb.window.api = {};
    await s.run();
    ok(
      s.opened.length === 0 && s.toasts.length === 1 && s.toasts[0].kind === "err",
      "宿主桥没有 shellOpenPath → err 提示（不静默、不抛）",
    );
  }

  /* ═══════════ [4] 样式与词条 ═══════════ */
  section("4 样式 / 词条");
  {
    ok(CSS.indexOf(".apps-dev-folderbtn") >= 0, "apps.css 有 .apps-dev-folderbtn 规则");
    const i = CSS.indexOf(".apps-dev-folderbtn");
    const block = CSS.slice(i, i + 260);
    ok(/flex:\s*none/.test(block), "按钮不参与伸缩（不挤 URL 那一行）");
    ok(/(white-space:\s*nowrap)|(line-height)/.test(block), "固定条高下收住行高 / 不折行");
    const urlBlock = CSS.slice(CSS.indexOf(".apps-dev-url {"), CSS.indexOf(".apps-dev-url {") + 200);
    ok(
      /flex:\s*1 1 auto/.test(urlBlock),
      ".apps-dev-url 是唯一的弹性项：把右端那一组按钮顶到右边（本轮补上）",
    );
    ok(
      CSS.indexOf(".apps-dev-bridgeclose") >= 0,
      "既有「关掉独立窗口」的规则仍在（新按钮与它同一处右端）",
    );
    const keys = [
      "📂 应用文件夹",
      "打开应用文件夹",
      "在资源管理器里打开这个应用的文件夹（入口页 index.html 所在的那个目录）",
      "先在左栏选一个应用",
      "读不到该应用文件夹（可能在别处被删了）",
      "已打开应用文件夹：",
      "无法打开文件夹：宿主桥未就绪",
    ];
    for (const k of keys) ok(I18N.indexOf('"' + k + '":') >= 0, "英文词条：" + k);
    /* 复用的既有词条（本轮不重复新增） */
    ok(I18N.indexOf('"无法打开文件夹：":') >= 0, "复用既有「无法打开文件夹：」词条");
    ok(
      APPS.indexOf("function appsMiniBtn(") >= 0 && APPS.indexOf("function appsToast(") >= 0,
      "appsMiniBtn / appsToast 仍是 app-apps.js 的全局实现（本文件按经典脚本共用作用域调）",
    );
  }

  console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " 项"));
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log("FAIL  用例抛错：" + ((err && err.stack) || err));
  process.exit(1);
});

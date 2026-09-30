/* ============ 应用模板 · 风格预览图渲染（本机脚本） ============
 *
 * 用法（在项目根跑，需要本仓的 electron）：
 *     node_modules\electron\dist\electron.exe scripts/app-style-previews.cjs
 *     node_modules\electron\dist\electron.exe scripts/app-style-previews.cjs tech glass
 *     node_modules\electron\dist\electron.exe scripts/app-style-previews.cjs --only=default
 *     npm run app:previews                    # 全部重出
 *
 * 干什么：把**真模板**按每种风格各渲染一次，固定视口 1200×820，拍首屏 PNG。两个目标：
 *
 *   templates/app-default（新建应用的默认欢迎页）
 *     → templates/app-default/previews/<id>.png     随包；新建应用 / 换风格浮层里给用户看的图
 *     → .impeccable/shots/app-default-<id>.png      本机取证目录（.gitignore 里，不入库）
 *   templates/app-scaffold（随包脚手架）
 *     → .impeccable/shots/app-scaffold-<id>.png     只留本机取证（脚手架不挂在任何选择界面上）
 *
 * 纪律：
 *   · 预览必须是「真模板渲染出来的」，不是另画一张图 —— 这里加载的就是模板目录里那一份，
 *     替换口径与主进程 apps-store.js 的 defaultPageHtml() 逐字相同（STYLE / APP_NAME /
 *     样式内联；脚手架那份是按它自己的两个 <link> 转成内联 <style>）。
 *   · 只写上面两个目录，不碰应用目录、不碰用户数据。
 *   · 隐性契约：每种风格都必须让页面真的画出来（近白 / 近黑整块 = 没渲染出来），
 *     所以这里做字节体检，失败当场报出来，绝不留几张静默的白图。
 *
 * 退出码：0 = 全部成功；1 = 有风格没出图（日志里逐条写明原因）。 */
"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

/* 预览图必须是 1200×820 的**像素**尺寸（应用窗口默认尺寸）：高 DPI 屏上
   capturePage 会按设备像素比放大（150% 屏 → 1800×1230），所以先把缩放钉成 1。 */
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("high-dpi-support", "0");

const ROOT = path.resolve(__dirname, "..");
const SHOTS_DIR = path.join(ROOT, ".impeccable", "shots");

/* 与 apps-store.js 的 APP_STYLES 同一份 id 清单（这里只用 id，名称与说明在那边） */
const STYLE_IDS = ["minimal", "tech", "warm", "editorial", "terminal", "glass", "retro"];
/* 预览视口（**每种模板按自己真实的窗口尺寸**，不是统一 1200×820）：
   · app-default 是应用入口页 → 1200×820 = apps-store.js 的 DEFAULT_WINDOW
   · app-scaffold 是便签演示那种小窗应用（280–1200 × 320–1200，起手约 560×700）
     → 用 560×700 拍，否则在 1200×820 里会被拉成一张空得不像话的页面 */
const VIEW_DEFAULT = { w: 1200, h: 820 };
const VIEW_SCAFFOLD = { w: 560, h: 700 };
const APP_NAME = "我的应用"; /* 预览里的示例标题：与浮层里那几张卡片同一句，便于横向比较 */

/* 两套模板的渲染口径（模板目录 · 入口页 · 结构样式 · 风格目录 · 预览图去处） */
const TARGETS = [
  {
    key: "default",
    label: "app-default ",
    dir: path.join(ROOT, "templates", "app-default"),
    tpl: "index.html",
    base: "base.css",
    styles: "styles",
    view: VIEW_DEFAULT,
    outDir: path.join(ROOT, "templates", "app-default", "previews"), /* 随包 */
    shotPrefix: "app-default-",
  },
  {
    key: "scaffold",
    label: "app-scaffold ",
    dir: path.join(ROOT, "templates", "app-scaffold"),
    tpl: "index.html",
    base: "style.css",
    styles: "styles",
    view: VIEW_SCAFFOLD,
    outDir: "", /* 脚手架不挂在选择界面上：只留取证目录 */
    shotPrefix: "app-scaffold-",
  },
];

function read(p) {
  return fs.readFileSync(p, "utf8");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[<>&"]/g, (c) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
  });
}
/* 模板 → 单文件 HTML：与主进程 defaultPageHtml() 同一口径。
   · app-default：{{STYLE_CSS}} 位置内联 base.css + styles/<id>.css
   · app-scaffold：把两个 <link rel="stylesheet">（style.css / styles/<id>.css）换成内联
     <style>，其余原样 —— 这样 data:URL 里也能看到与 file:// 装载一致的观感。 */
function renderStyleHtml(t, id) {
  const tpl = read(path.join(t.dir, t.tpl));
  const css = [
    read(path.join(t.dir, t.base)),
    read(path.join(t.dir, t.styles, id + ".css")),
  ].join("\n\n");
  let html = tpl;
  if (t.key === "scaffold") {
    const links = /[ \t]*<link[^>]*rel="stylesheet"[^>]*>\s*/gi;
    html = html.replace(links, "");
    html = html.replace("</head>", "    <style>\n" + css + "\n    </style>\n  </head>");
  } else {
    html = html.replace(/\{\{STYLE_CSS\}\}/g, () => css);
  }
  return html
    .replace(/\{\{APP_NAME\}\}/g, () => esc(APP_NAME))
    .replace(/\{\{STYLE\}\}/g, () => id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, html, t, id) {
  const VW = t.view.w;
  const VH = t.view.h;
  win.setContentSize(VW, VH);
  const url = "data:text/html;charset=utf-8," + encodeURIComponent(html);
  await win.loadURL(url);
  /* data: URL 没有 query，入场动画用一帧后补 class 的方式按住（与 ?still=1 同一个类） */
  await win.webContents.executeJavaScript(
    "document.body && document.body.classList.add('still');",
    true,
  );
  try {
    await win.webContents.executeJavaScript(
      "(document.fonts && document.fonts.ready) || true",
      true,
    );
  } catch (_) {}
  await sleep(260); /* 两帧 + 字体落定 */
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: VW, height: VH });
  const buf = img.toPNG();
  const size = img.getSize();
  const wrote = [];
  if (t.outDir && !t.noCommit) {
    const p = path.join(t.outDir, id + ".png");
    fs.writeFileSync(p, buf);
    wrote.push(path.relative(ROOT, p));
  }
  const shotName = t.shotPrefix + id + (t.shotSuffix || "") + ".png";
  try {
    const s = path.join(SHOTS_DIR, shotName);
    fs.writeFileSync(s, buf);
    wrote.push(path.relative(ROOT, s));
  } catch (_) {}
  return { bytes: buf.length, w: size.width, h: size.height, wrote: wrote };
}

function parseArgs(argv) {
  const onlyTargets = [];
  const onlyIds = [];
  let views = null; /* --view=WxH：只改取证截图的视口，**不动**随包预览图的尺寸口径 */
  let shotsOnly = false;
  for (const a of argv) {
    if (!a) continue;
    if (a.indexOf("--only=") === 0) {
      for (const k of a.slice(7).split(",")) if (k.trim()) onlyTargets.push(k.trim());
    } else if (a.indexOf("--view=") === 0) {
      const m = a.slice(7).match(/^(\d{3,4})x(\d{3,4})$/i);
      if (m) views = { w: Number(m[1]), h: Number(m[2]) };
    } else if (a === "--shots-only") {
      shotsOnly = true;
    } else if (a[0] === "-") {
      continue;
    } else {
      onlyIds.push(a);
    }
  }
  return { onlyTargets: onlyTargets, onlyIds: onlyIds, views: views, shotsOnly: shotsOnly };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let targets = TARGETS.filter(
    (t) => !args.onlyTargets.length || args.onlyTargets.indexOf(t.key) >= 0,
  );
  /* --view=WxH 是「换一个视口再拍一遍细看」：只写取证目录、文件名带尺寸后缀，
     不覆盖随包预览图（预览图必须是应用真实窗口尺寸那一档，口径见上面注释）。 */
  if (args.views) {
    targets = targets.map((t) => ({
      key: t.key,
      label: t.label,
      dir: t.dir,
      tpl: t.tpl,
      base: t.base,
      styles: t.styles,
      view: args.views,
      outDir: t.outDir,
      noCommit: true,
      shotPrefix: t.shotPrefix,
      shotSuffix: "-" + args.views.w + "x" + args.views.h,
    }));
  } else if (args.shotsOnly) {
    targets = targets.map((t) => Object.assign({}, t, { outDir: "" }));
  }
  if (!targets.length) {
    console.error("[style-previews] --only= 没匹配到目标（可用：" + TARGETS.map((t) => t.key).join(" / ") + "）");
    process.exitCode = 1;
    return;
  }
  const ids = args.onlyIds.length ? args.onlyIds : STYLE_IDS;
  let bad = 0;
  for (const id of ids) {
    if (STYLE_IDS.indexOf(id) < 0) {
      console.error("[style-previews] 未知风格 id：" + id);
      process.exitCode = 1;
    }
  }
  const todo = ids.filter((id) => STYLE_IDS.indexOf(id) >= 0);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  for (const t of targets) {
    if (t.outDir) fs.mkdirSync(t.outDir, { recursive: true });
    for (const id of todo) {
      const p = path.join(t.dir, t.styles, id + ".css");
      if (!fs.existsSync(p)) {
        console.error("[style-previews] 缺 " + path.relative(ROOT, p));
        bad++;
      }
    }
  }

  const win = new BrowserWindow({
    width: targets[0].view.w,
    height: targets[0].view.h,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: "#0a0c12",
    webPreferences: {
      offscreen: false,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: true,
    },
  });

  for (const t of targets) {
    for (const id of todo) {
      try {
        const html = renderStyleHtml(t, id);
        const r = await shoot(win, html, t, id);
        /* 体检：真的画出来了？近空图（或尺寸异常）一律判失败，别留静默白图 */
        const okBytes = r.bytes > 6000;
        console.log(
          "[style-previews] " +
            (okBytes ? "ok  " : "BAD ") +
            t.label.padEnd(12) +
            id.padEnd(10) +
            r.w +
            "×" +
            r.h +
            "  " +
            String(Math.round(r.bytes / 1024)).padStart(4) +
            " KB  → " +
            r.wrote.join("  ·  "),
        );
        if (!okBytes) bad++;
      } catch (err) {
        bad++;
        console.error(
          "[style-previews] FAIL " + t.label + "/" + id + "：" + ((err && err.message) || err),
        );
      }
    }
  }
  try {
    win.destroy();
  } catch (_) {}
  if (bad) {
    process.exitCode = 1;
    console.error("[style-previews] " + bad + " 项没出图");
  }
}

app.whenReady().then(() =>
  main()
    .catch((err) => {
      console.error("[style-previews] " + ((err && err.stack) || err));
      process.exitCode = 1;
    })
    .finally(() => app.quit()),
);
/* 隐藏窗口在部分环境下会因为没有可见窗口提前 quit：显式按住生命周期 */
app.on("window-all-closed", () => {});
"use strict";
/* ============================================================
 * 截图标注工具（主进程侧 · 零新依赖）
 * ------------------------------------------------------------
 * 一句话：`Ctrl + Alt + A` → 拍下鼠标所在那块屏 → 全屏置顶浮层显示这张「冻结画面」
 * → 用户像微信截图那样框出关键区域并裁剪 → 在裁剪图上画标注、写备注
 * → 把「带编号圆点的图 + 编号备注清单」以一段 Markdown 写进系统剪贴板。
 *
 * 为什么必须有主进程这一半：
 *   ① 抓别人的窗口 / 屏幕只有主进程能做（`desktop-capture.js` 的 PowerShell + GDI 链路），
 *      渲染层没有跨窗口截屏能力（`webContents.capturePage` 只拍自己）；
 *   ② 全屏置顶浮层是一只 BrowserWindow，渲染层建不出来；
 *   ③ 系统剪贴板写入与 PNG 落盘走 `clipboard` / `fs`，都在主进程。
 *
 * 冻结的做法：**先拍、再显示**。先把整块虚拟桌面拍成 PNG（此时浮层还不存在，不会把自己拍进去），
 * 再把浮层铺到鼠标所在那块屏上、把图片按该屏对应的物理区域画满整窗。用户在浮层上看到的
 * 是「一张静止的照片」，不是实时的桌面 —— 所以弹菜单、放视频都不会让选区跑掉。
 *
 * 坐标口径（三套，别混）：
 *   · 物理像素 phys   = PNG 里的像素，PowerShell / GDI 的坐标系；
 *   · 裁剪坐标 crop   = 相对「裁剪图」左上角的物理像素（备注清单里写出去的就是这一套）；
 *   · CSS 像素 screen = 浮层里的布局像素（= phys / 屏缩放比），只在本模块与渲染层之间用。
 *
 * 这个文件**不 require electron**：主进程只注入 BrowserWindow / screen / ipcMain / globalShortcut
 * / clipboard 与截图函数，所以 test/smoke-screenshot-tool.js 能在纯 Node 下把纯函数与
 * 窗口生命周期钉住（假 BrowserWindow）。
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

/* 文案走与渲染层同一份 i18n（UMD，照 desktop-capture.js 的惯例）：英文界面下错误提示同样是英文。 */
let I18n = null;
try {
  I18n = require("./renderer/i18n.js");
} catch {}
const t = (s, vars) => {
  try {
    return I18n && typeof I18n.t === "function" ? I18n.t(s, vars) : String(s);
  } catch {
    return String(s);
  }
};

/* 全局唤起键：需求里点名要 Ctrl + Alt + A（避开系统 Win+Shift+S 与微信 Alt+A）。 */
const DEFAULT_ACCEL = "Control+Alt+A";
/* IPC 频道前缀：全部集中在这里，渲染层与 preload 只认这一份常量。 */
const CH = {
  init: "shot:init",
  candidates: "shot:candidates",
  finish: "shot:finish",
  saveAs: "shot:save-as",
  reveal: "shot:reveal",
  close: "shot:close",
  cancel: "shot:cancel",
};

/* 标注类型的中文 / 英文名（备注清单里写给人看的那一段） */
const KIND_LABELS = {
  rect: ["矩形", "rectangle"],
  arrow: ["箭头", "arrow"],
  pen: ["画笔", "pen"],
  text: ["文字", "text"],
};
function kindLabel(kind) {
  const pair = KIND_LABELS[String(kind || "").trim()] || null;
  if (!pair) return String(kind || t("标注"));
  return t(pair[0]) === pair[0] ? pair[1] : pair[0];
}

/* ── 纯函数（可单测） ───────────────────────────────────────── */

/* 文件名时间戳：shot-20250101-120000-123.png 里的那一段 */
function stampOf(now) {
  const d = new Date(typeof now === "number" ? now : Date.now());
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds()) +
    "-" +
    p(d.getMilliseconds(), 3)
  );
}

/* 矩形归一：任意两点 → 正矩形（x2 < x1 也认）；宽高至少 1，且裁到 bounds 内 */
function normRect(a, b, bounds) {
  const x1 = Math.round(Math.min(a.x, b.x));
  const y1 = Math.round(Math.min(a.y, b.y));
  const x2 = Math.round(Math.max(a.x, b.x));
  const y2 = Math.round(Math.max(a.y, b.y));
  let r = { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  if (bounds) r = clampRect(r, bounds);
  return r;
}

/* 把矩形夹进 bounds（宽高不变时优先保留左上角，越界再缩） */
function clampRect(r, bounds) {
  const bw = Math.max(1, Math.round(Number(bounds && bounds.w) || 0));
  const bh = Math.max(1, Math.round(Number(bounds && bounds.h) || 0));
  let w = Math.max(1, Math.min(Math.round(Number(r.w) || 1), bw));
  let h = Math.max(1, Math.min(Math.round(Number(r.h) || 1), bh));
  let x = Math.round(Number(r.x) || 0);
  let y = Math.round(Number(r.y) || 0);
  x = Math.max(0, Math.min(x, bw - w));
  y = Math.max(0, Math.min(y, bh - h));
  return { x: x, y: y, w: w, h: h };
}

/* 两块矩形是否相交（只判面积 > 0 的重叠，贴边不算） */
function rectsIntersect(a, b) {
  if (!a || !b) return false;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  return a.x < bx2 && b.x < ax2 && a.y < by2 && b.y < ay2;
}

/* 目标屏在「整块虚拟桌面」这张大图里的物理矩形 = 该屏物理矩形 - 虚拟桌面原点。
   为什么要显式算原点：Windows 的虚拟桌面可能从负坐标开始（副屏在主屏左边 / 上方），
   PowerShell 拍出来的图以虚拟桌面左上角为 (0,0)，不减去原点整体就会偏一屏。 */
function cropRectOf(targetPhys, allPhys) {
  const list = Array.isArray(allPhys) && allPhys.length ? allPhys : [targetPhys];
  let ox = Infinity;
  let oy = Infinity;
  for (const r of list) {
    ox = Math.min(ox, Math.round(Number(r.x) || 0));
    oy = Math.min(oy, Math.round(Number(r.y) || 0));
  }
  if (!Number.isFinite(ox)) ox = 0;
  if (!Number.isFinite(oy)) oy = 0;
  return {
    x: Math.round(Number(targetPhys.x) || 0) - ox,
    y: Math.round(Number(targetPhys.y) || 0) - oy,
    w: Math.max(1, Math.round(Number(targetPhys.width || targetPhys.w) || 1)),
    h: Math.max(1, Math.round(Number(targetPhys.height || targetPhys.h) || 1)),
  };
}

/* 候选窗口矩形 → 裁剪图坐标。丢掉：完全不在截图里的、看不见的（visible:false）、
   浮层自己（它全屏置顶，不剔掉的话每个悬停点都先命中它）。
   **顺序 = Z 序**（z=0 最上层）：渲染层按这个顺序命中光标点，第一个命中的就是
   「用户眼前那个窗口」—— 被压在下层的窗口自然选不到。以前按面积大小猜，
   于是被遮挡的窗口也会被选中（用户报的「选到被遮挡的窗口」）。
   没有 z 的旧实现排在最后，仍按面积从小到大，行为与以前一致。 */
function mapCandidates(windows, crop, excludeHwnds) {
  const out = [];
  const list = Array.isArray(windows) ? windows : [];
  const skip = new Set();
  for (const h of Array.isArray(excludeHwnds) ? excludeHwnds : []) {
    const n = Number(h) || 0;
    if (n) skip.add(n);
  }
  for (const w of list) {
    if (!w || w.visible === false) continue;
    const hwnd = Number(w.hwnd) || 0;
    if (hwnd && skip.has(hwnd)) continue;
    const rect = {
      x: Math.round(Number(w.x) || 0) - crop.x,
      y: Math.round(Number(w.y) || 0) - crop.y,
      w: Math.max(1, Math.round(Number(w.width || w.w) || 1)),
      h: Math.max(1, Math.round(Number(w.height || w.h) || 1)),
    };
    if (!rectsIntersect(rect, { x: 0, y: 0, w: crop.w, h: crop.h })) continue;
    const z = Number(w.z);
    out.push({
      title: String(w.title || ""),
      process: String(w.process || ""),
      hwnd: hwnd,
      z: Number.isFinite(z) ? z : 1e6,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
  }
  out.sort((a, b) => a.z - b.z || a.w * a.h - b.w * b.h);
  return out;
}

/* 一条标注 → 一行可读文字。给模型看的东西，宁可冗余也别含糊：
   坐标一律写清是「裁剪图内像素、原点左上角」，模型不会把框内坐标当整屏坐标用。 */
function noteLine(note) {
  const n = Number(note && note.n) || 0;
  const kind = String((note && note.kind) || "").trim();
  const label = kindLabel(kind);
  const x = Math.round(Number(note && note.x) || 0);
  const y = Math.round(Number(note && note.y) || 0);
  const w = Math.round(Number(note && note.w) || 0);
  const h = Math.round(Number(note && note.h) || 0);
  const pos =
    kind === "text" || (w <= 0 && h <= 0)
      ? `(x=${x}, y=${y})`
      : `(x=${x}, y=${y}, w=${w}, h=${h})`;
  const text = String((note && note.text) || "").trim();
  return (
    n +
    ". " +
    label +
    " " +
    pos +
    (text ? "：" + text : "：" + t("（没有写备注）"))
  );
}

/* 剪贴板里那一段 Markdown：图片绝对路径 + 图像尺寸 + 编号备注清单。
   `![](路径)` 这一行的写法是刻意的 —— MTNode 的会话 / 助手输入框把「正文里一行图」投影成
   胶囊条（renderer/app-inline-img.js），粘进去就同时有图和文字。 */
function buildMarkdown(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const p = String(o.imagePath || "").trim();
  const w = Math.round(Number(o.imageW) || 0);
  const h = Math.round(Number(o.imageH) || 0);
  const notes = Array.isArray(o.notes) ? o.notes.slice() : [];
  notes.sort((a, b) => (Number(a && a.n) || 0) - (Number(b && b.n) || 0));
  const head = p ? "![" + t("截图") + "](" + p + ")" : "![" + t("截图") + "]()";
  const lines = [head, ""];
  lines.push(
    (w && h ? t("图像尺寸：") + w + "×" + h : t("图像尺寸：未知")) +
      t("（下列坐标均为裁剪图内像素，原点在左上角）"),
  );
  if (notes.length) {
    lines.push("");
    lines.push(t("标注清单（编号与图上圆点一一对应）："));
    for (const n of notes) lines.push(noteLine(n));
  } else {
    lines.push("");
    lines.push(t("这次没有标注，只有截图本身。"));
  }
  return lines.join("\n");
}

/* 落盘文件名：shot-<时间戳>.png（与 desktop-capture.js 的 shot- 前缀同族，便于一眼认出） */
function shotFileName(now) {
  return "shot-" + stampOf(now) + ".png";
}

/* dataUrl → Buffer（只认 PNG / JPEG 的 data URL；纯 base64 也收） */
function dataUrlToBuffer(dataUrl) {
  const s = String(dataUrl || "");
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,/i.exec(s);
  const raw = m ? s.slice(m[0].length) : s.replace(/^data:[^,]*,/, "");
  if (!raw) return null;
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return null;
  }
}

/* 浮层自己的 HWND：窗口枚举里必须把它剔掉 —— 它是全屏置顶，不剔的话每个悬停点都会
   先命中它自己（枚举有可能在浮层显示之后才回来）。Electron 在 Windows 上给的是
   8 字节 Buffer（小端指针）；拿不到就回 0（不剔，退回「没有候选过滤」的行为）。 */
function nativeHandleOf(win) {
  try {
    const h = win && typeof win.getNativeWindowHandle === "function" ? win.getNativeWindowHandle() : null;
    if (!h || !h.length) return 0;
    if (h.length >= 8 && typeof h.readBigUInt64LE === "function") return Number(h.readBigUInt64LE(0));
    if (typeof h.readUInt32LE === "function") return h.readUInt32LE(0);
    return 0;
  } catch (_) {
    return 0;
  }
}

/* ── 对外工厂 ─────────────────────────────────────────────────
   deps：
     BrowserWindow       Electron 的 BrowserWindow（测试传假类）
     screen              Electron 的 screen（要 getCursorScreenPoint / getDisplayNearestPoint /
                         getPrimaryDisplay / getAllDisplays / dipToScreenRect）
     ipcMain             注册 IPC（handle）
     globalShortcut      注册全局快捷键
     clipboard           写剪贴板（writeText）
     capture             async (params) => { ok, path, width, height }（= desktop-capture 的 capture）
     listWindows         async () => { ok, windows:[{title,process,x,y,width,height,visible}] }
     htmlPath            renderer/screenshot.html 的绝对路径
     preloadPath         preload-screenshot.js 的绝对路径
     outDir              成品 PNG 落盘目录（数据目录下的 captures/）
     dialog              Electron 的 dialog（「保存」按钮的系统另存为；不注入 = 该功能明确报不支持）
     reveal              async (path) => { ok, path }（「打开文件夹」；主进程注入带兜底那一条）
     accel               可选，覆盖快捷键（测试用）
     log                 可选，日志出口 */
function createScreenshotTool(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const BrowserWindow = d.BrowserWindow;
  const screen = d.screen;
  const ipcMain = d.ipcMain;
  const globalShortcut = d.globalShortcut;
  const clipboard = d.clipboard;
  const dialog = d.dialog || null;
  const reveal = typeof d.reveal === "function" ? d.reveal : null;
  const capture = typeof d.capture === "function" ? d.capture : null;
  const listWindows = typeof d.listWindows === "function" ? d.listWindows : null;
  const htmlPath = String(d.htmlPath || "");
  const preloadPath = String(d.preloadPath || "");
  const outDir = String(d.outDir || "").trim();
  const accel = String(d.accel || DEFAULT_ACCEL);
  const log = typeof d.log === "function" ? d.log : () => {};

  let win = null;
  /* 一次打开期间的上下文：{ imgPath, imgW, imgH, crop, cssW, cssH, scale, candidates, agent } */
  let ctx = null;
  /* Agent 发起时挂着的等待者：{ resolve, agent:true } —— 用户标完 / 取消都是它收口 */
  let pending = null;
  let hotkeyState = { ok: false, accel: accel, error: "" };

  function alive() {
    return !!(win && !win.isDestroyed());
  }
  function outDirAbs() {
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (_) {}
    return outDir;
  }
  function send(channel, payload) {
    if (!alive() || !win.webContents) return;
    try {
      win.webContents.send(channel, payload);
    } catch (_) {}
  }
  /* 收口：成功 / 取消都走这里，保证 Agent 那一侧永远拿得到结果（不会永远挂着） */
  function settle(result) {
    const p = pending;
    pending = null;
    if (p && typeof p.resolve === "function") {
      try {
        p.resolve(result);
      } catch (_) {}
    }
    return result;
  }
  /* 关窗 + 清中间产物（原始整屏 PNG 只是渲染层的背景照片，交付的是标注后的成品） */
  function teardown() {
    const raw = ctx && ctx.imgPath ? String(ctx.imgPath) : "";
    ctx = null;
    if (alive()) {
      const w = win;
      win = null;
      try {
        w.close();
      } catch (_) {}
      try {
        w.destroy();
      } catch (_) {}
    }
    if (raw) {
      try {
        fs.unlinkSync(raw);
      } catch (_) {}
    }
  }

  /* 虚拟桌面在 Electron 坐标系里的外接矩形。**只看相对位置，不解释单位**：
     同一台机器上 Display.bounds、PowerShell 的屏幕矩形、页面 devicePixelRatio 三者
     在高 DPI / 远程桌面下经常互相矛盾（实测 Electron 报 scaleFactor 1.5，真实缩放是 1.25，
     dipToScreenRect 算出来的「物理矩形」比真桌面还大 900px），所以一律按比例换算。 */
  function deskBox() {
    const list = displaysOf();
    if (!list.length) return null;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const d of list) {
      const b = (d && d.bounds) || {};
      const x = Number(b.x) || 0;
      const y = Number(b.y) || 0;
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + Math.max(1, Number(b.width) || 1));
      y2 = Math.max(y2, y + Math.max(1, Number(b.height) || 1));
    }
    if (!(x2 > x1) || !(y2 > y1)) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  /* 目标屏在「整块虚拟桌面」那张图里占哪一块：屏幕矩形 → 图片像素，按比例换算并夹进图内 */
  function cropFor(bounds, capW, capH) {
    const W = Math.max(1, Math.round(Number(capW) || 0));
    const H = Math.max(1, Math.round(Number(capH) || 0));
    const b = bounds || {};
    const box = deskBox();
    if (!box) {
      /* 没有屏清单就退回「整张图」（宁可多给一点，也不要裁错屏） */
      return { x: 0, y: 0, w: W, h: H };
    }
    const sx = W / box.w;
    const sy = H / box.h;
    const rect = {
      x: Math.round(((Number(b.x) || 0) - box.x) * sx),
      y: Math.round(((Number(b.y) || 0) - box.y) * sy),
      width: Math.round((Math.max(1, Number(b.width) || 1)) * sx),
      height: Math.round((Math.max(1, Number(b.height) || 1)) * sy),
    };
    /* clampRect 收的是 {x,y,w,h}（不是 width/height） */
    return clampRect({ x: rect.x, y: rect.y, w: rect.width, h: rect.height }, { w: W, h: H });
  }

  function displaysOf() {
    try {
      const list = screen && typeof screen.getAllDisplays === "function" ? screen.getAllDisplays() : [];
      if (Array.isArray(list) && list.length) return list;
    } catch (_) {}
    try {
      const one = screen && typeof screen.getPrimaryDisplay === "function" ? screen.getPrimaryDisplay() : null;
      if (one) return [one];
    } catch (_) {}
    return [];
  }

  /* 鼠标所在那块屏（拿不到就主屏） */
  function targetDisplay() {
    const list = displaysOf();
    try {
      if (screen && typeof screen.getCursorScreenPoint === "function" && typeof screen.getDisplayNearestPoint === "function") {
        const pt = screen.getCursorScreenPoint();
        const hit = screen.getDisplayNearestPoint(pt);
        if (hit && hit.bounds) return hit;
      }
    } catch (_) {}
    try {
      if (screen && typeof screen.getPrimaryDisplay === "function") {
        const one = screen.getPrimaryDisplay();
        if (one && one.bounds) return one;
      }
    } catch (_) {}
    return list[0] || { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  }

  /* 拍一张 → 建浮层。origin: "hotkey" | "agent"（决定标完后要不要把结果回给 Agent） */
  async function open(options) {
    const o = options && typeof options === "object" ? options : {};
    const origin = String(o.origin || "hotkey");
    if (alive()) {
      try {
        win.focus();
      } catch (_) {}
      /* 已经开着（用户自己按了快捷键）：不再抢一层窗；Agent 如实回「占用中」，
         别让它拿到一个「ok 却没有图」的结果 —— 那比报错更难查。 */
      if (origin === "agent")
        return { ok: false, busy: true, path: "", error: t("截图浮层已经打开了，等它关掉再试一次") };
      return { ok: true, reused: true, path: "", canceled: false };
    }
    if (typeof capture !== "function")
      return { ok: false, error: t("截图不可用：主进程没有注入截图函数") };
    if (!BrowserWindow || !htmlPath)
      return { ok: false, error: t("截图浮层不可用：缺少窗口或页面路径") };

    const display = targetDisplay();
    const bounds = display.bounds || { x: 0, y: 0, width: 1280, height: 720 };

    /* ① 抓屏与窗口枚举**同时**开跑：两者互不依赖，串起来就是白等一轮
       （实测抓屏 501ms + 枚举 410ms，用户感觉到的就是「按了快捷键要停一下」）。
       枚举晚到不要紧 —— 浮层先用框选，候选窗随后补（CH.candidates）。 */
    const capP = (async () => {
      let cursorShot = true;
      let shot = null;
      try {
        /* 直接拍「鼠标所在那块屏」：判屏与抓取都在 PowerShell 自己的坐标系里完成
           （Cursor.Position → Screen.FromPoint → CopyFromScreen），主进程不再做
           「DIP ↔ 物理像素」的换算 —— 之前是整桌面拍一张再按比例裁那块屏，
           一旦两块屏缩放比不同、或 Windows 把坐标虚拟化了，裁出来就只剩桌面的一角
           （用户报的「像被放大 / 偏移」就是这么来的）。 */
        shot = await capture({ target: "cursor" });
      } catch (err) {
        shot = { ok: false, error: (err && err.message) || String(err) };
      }
      if (!shot || shot.ok !== true) {
        /* 老版本截图实现 / 认不出 cursor：退回整块虚拟桌面 + 按比例裁（以前的行为，仍能用） */
        cursorShot = false;
        try {
          shot = await capture({ target: "all" });
        } catch (err) {
          shot = { ok: false, error: (err && err.message) || String(err) };
        }
      }
      return { shot: shot, cursorShot: cursorShot };
    })();
    const lwP =
      typeof listWindows === "function"
        ? (async () => {
            try {
              return await listWindows();
            } catch (_) {
              return null;
            }
          })()
        : Promise.resolve(null);

    /* ② 先建窗（**不显示**）并把页面也点着：抓屏还在跑的时候页面已经在后台载好了，
       抓屏一回来 show 就能直接画。窗口必须等抓屏回来才能 show —— 早一步就会把自己
       拍进冻结画面（所以显示是「抓屏完成 + 页面就绪」两个条件的与）。 */
    let w = null;
    try {
      w = new BrowserWindow({
        x: Math.round(Number(bounds.x) || 0),
        y: Math.round(Number(bounds.y) || 0),
        width: Math.max(1, Math.round(Number(bounds.width) || 1)),
        height: Math.max(1, Math.round(Number(bounds.height) || 1)),
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        backgroundColor: "#000000",
        title: t("截图标注"),
        webPreferences: {
          preload: preloadPath || undefined,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          spellcheck: false,
        },
      });
    } catch (err) {
      ctx = null;
      return settle({ ok: false, error: (err && err.message) || String(err) });
    }
    win = w;
    /* 全屏要在 show 之前定下来：after-show 再切会闪一下，而且在混合 DPI / 远程桌面下
       会悄悄不生效（实测客户区只铺到屏高的 79%）。ready-to-show 里还有一道兜底。 */
    try {
      if (typeof w.setFullScreen === "function") w.setFullScreen(true);
    } catch (_) {}
    try {
      w.setMenu(null);
    } catch (_) {}
    try {
      w.setAlwaysOnTop(true, "screen-saver");
    } catch (_) {}
    try {
      if (w.webContents && typeof w.webContents.on === "function") {
        w.webContents.on("will-navigate", (ev) => {
          if (ev && ev.preventDefault) ev.preventDefault();
        });
      }
      if (w.webContents && typeof w.webContents.setWindowOpenHandler === "function") {
        w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      }
    } catch (_) {}
    /* 覆盖守护：混合 DPI / 远程桌面下「全屏」偶发不生效（实测客户区只到屏高的 79%），
       那会让用户看到一圈没被冻结的桌面。这里量一次实际尺寸，没铺满就再要一次全屏 / 直接设 bounds。 */
    const wantW = Math.max(1, Math.round(Number(bounds.width) || 1));
    const wantH = Math.max(1, Math.round(Number(bounds.height) || 1));
    let coverTries = 3;
    const ensureCover = () => {
      if (!alive() || win !== w || w.isDestroyed()) return;
      let b = null;
      try {
        b = w.getBounds();
      } catch (_) {
        b = null;
      }
      const covered = b && Math.abs(b.width - wantW) <= 8 && Math.abs(b.height - wantH) <= 8;
      if (covered) return;
      try {
        if (typeof w.setFullScreen === "function" && !w.isFullScreen()) w.setFullScreen(true);
      } catch (_) {}
      try {
        w.setBounds({
          x: Math.round(Number(bounds.x) || 0),
          y: Math.round(Number(bounds.y) || 0),
          width: wantW,
          height: wantH,
        });
      } catch (_) {}
      if (coverTries-- > 0) setTimeout(ensureCover, 350);
    };
    let pageReady = false;
    let capOk = false;
    let shown = false;
    let selfHwnd = 0;
    const revealOverlay = () => {
      if (shown || !capOk || !pageReady) return;
      if (!alive() || win !== w || w.isDestroyed()) return;
      shown = true;
      try {
        w.show();
      } catch (_) {}
      /* 再进全屏：混合 DPI / 远程桌面下「按 Display.bounds 建窗」拿到的客户区
         经常比显示器小一圈（实测只剩 75%），全屏才是唯一能让浮层真正铺满那块屏的做法。 */
      try {
        if (typeof w.setFullScreen === "function" && !w.isFullScreen()) w.setFullScreen(true);
      } catch (_) {}
      try {
        if (!w.isDestroyed()) w.focus();
      } catch (_) {}
      setTimeout(ensureCover, 150);
      setTimeout(ensureCover, 600);
    };
    w.once("ready-to-show", () => {
      pageReady = true;
      revealOverlay();
    });
    w.on("enter-full-screen", () => {
      try {
        if (!w.isDestroyed()) w.focus();
      } catch (_) {}
    });
    w.on("closed", () => {
      if (win === w) win = null;
      const raw = ctx && ctx.imgPath ? String(ctx.imgPath) : "";
      ctx = null;
      if (raw) {
        try {
          fs.unlinkSync(raw);
        } catch (_) {}
      }
      /* 关窗而没走 finish = 取消（Esc / 右上角 ✕ / 直接关掉） */
      settle({ ok: false, canceled: true, path: "" });
    });
    const pageP = w.loadFile(htmlPath).then(
      () => true,
      (err) => err || true,
    );

    /* ③ 抓屏回来：定裁剪、交上下文。页面多半已经就绪，这里 show 出去就是那张冻结画面。 */
    const capRes = await capP;
    const cap = capRes.shot;
    if (!cap || cap.ok !== true) {
      teardown();
      return settle({ ok: false, error: String((cap && cap.error) || t("截图失败")) });
    }

    /* 光标屏直拍：整张图就是那块屏，裁剪 = 整图（没有换算，也就没有换算错的可能）；
       退回整桌面时才需要按比例找回那块屏。 */
    const crop = capRes.cursorShot
      ? {
          x: 0,
          y: 0,
          w: Math.max(1, Math.round(Number(cap.width) || 1)),
          h: Math.max(1, Math.round(Number(cap.height) || 1)),
        }
      : cropFor(bounds, cap.width, cap.height);
    /* 抓到的图在 PowerShell 坐标系里的原点：候选窗口矩形与它同一套坐标，
       减掉原点才落到图片像素上（多屏时原点常常是负数，不减会整体偏移） */
    const imgOrigin = {
      x: Math.round(Number(cap.x) || 0),
      y: Math.round(Number(cap.y) || 0),
    };

    const scale = crop.w / Math.max(1, Number(bounds.width) || 1);
    ctx = {
      imgPath: String(cap.path || ""),
      imgW: Math.max(1, Number(cap.width) || crop.w),
      imgH: Math.max(1, Number(cap.height) || crop.h),
      crop: crop,
      cssW: Math.max(1, Number(bounds.width) || 1),
      cssH: Math.max(1, Number(bounds.height) || 1),
      scale: scale,
      candidates: [],
      windowsReady: null,
      origin: origin,
      rawDir: String(cap.outDir || ""),
    };

    /* Agent 发起：先挂上等待者再显示，避免用户手快标完而我们还没准备好收结果 */
    let waiter = null;
    if (origin === "agent") {
      waiter = new Promise((resolve) => {
        pending = { resolve: resolve };
      });
    }

    /* ④ 候选窗口（Z 序）：晚到就晚到 —— 页面先能用框选，悬停高亮随后补上 */
    selfHwnd = nativeHandleOf(w);
    ctx.windowsReady = lwP
      .then((lw) => {
        const list =
          lw && lw.ok === true
            ? mapCandidates(
                lw.windows,
                { x: imgOrigin.x + crop.x, y: imgOrigin.y + crop.y, w: crop.w, h: crop.h },
                [selfHwnd],
              )
            : [];
        if (ctx) ctx.candidates = list;
        return list;
      })
      .catch(() => []);
    capOk = true;
    revealOverlay();

    const loaded = await pageP;
    if (loaded !== true) {
      log("[shot] loadFile 失败：" + ((loaded && loaded.message) || loaded));
      teardown();
      /* 页面还没加载完就被关掉（用户按 Esc / 关窗 / 自验脚本 close()）时 loadFile 会以
         ERR_FAILED 收场 —— 那不是失败，照常按「取消」收口，别让调用方挂着一个假错误。 */
      if (!alive() || (loaded && /ERR_FAILED|ERR_ABORTED/.test(String(loaded.message || loaded))))
        return settle({ ok: false, canceled: true, path: "" });
      return settle({ ok: false, error: String((loaded && loaded.message) || loaded) });
    }
    if (!waiter) return { ok: true, path: "", canceled: false };
    return waiter;
  }

  /* 快捷键注册（失败要说清是被占用，而不是静默不生效） */
  function registerHotkey() {
    try {
      if (!globalShortcut || typeof globalShortcut.register !== "function") {
        hotkeyState = { ok: false, accel: accel, error: t("这个环境不支持全局快捷键") };
        return hotkeyState;
      }
      if (typeof globalShortcut.isRegistered === "function" && globalShortcut.isRegistered(accel)) {
        hotkeyState = { ok: true, accel: accel, error: "" };
        return hotkeyState;
      }
      const ok = globalShortcut.register(accel, () => {
        open({ origin: "hotkey" }).catch((e) => log("[shot] 打开失败：" + ((e && e.message) || e)));
      });
      hotkeyState = ok
        ? { ok: true, accel: accel, error: "" }
        : { ok: false, accel: accel, error: t("快捷键被其它程序占用了：") + accel };
      return hotkeyState;
    } catch (err) {
      hotkeyState = { ok: false, accel: accel, error: (err && err.message) || String(err) };
      return hotkeyState;
    }
  }
  function unregisterHotkey() {
    try {
      if (globalShortcut && typeof globalShortcut.unregister === "function") globalShortcut.unregister(accel);
    } catch (_) {}
  }

  /* ── IPC（只认自己那只浮层发来的消息）───────────────────────── */
  const fromMine = (e) => !!(win && !win.isDestroyed() && e && e.sender === win.webContents);
  let ipcReady = false;
  function registerIpc() {
    if (!ipcMain || typeof ipcMain.handle !== "function") return;
    /* 幂等：同一进程里再调一次不该炸（主进程重启初始化 / 自验脚本建第二只实例都会踩到）。
       五个口子只有一个处理函数，谁后注册谁生效 —— 它们都按 fromMine 判归属，不会串窗。 */
    if (ipcReady) return;
    ipcReady = true;
    [CH.init, CH.candidates, CH.finish, CH.saveAs, CH.reveal, CH.close, CH.cancel].forEach((ch) => {
      try {
        if (typeof ipcMain.removeHandler === "function") ipcMain.removeHandler(ch);
      } catch (_) {}
    });
    ipcMain.handle(CH.init, (e) => {
      /* 抓屏与载页是并行的：页面可能比抓屏先载好（早一两百毫秒），这时 ctx 还没就绪。
         回一个 retry 标记，渲染层稍后再问一次 —— 比让它报「截图已结束」准确得多。 */
      if (!fromMine(e)) return { ok: false, error: t("截图已结束") };
      if (!ctx) return { ok: false, retry: true, error: t("截图已结束") };
      const fileUrl = ctx.imgPath ? pathToFileURL(ctx.imgPath).href : "";
      return {
        ok: true,
        imgUrl: fileUrl,
        imgW: ctx.imgW,
        imgH: ctx.imgH,
        crop: ctx.crop,
        cssW: ctx.cssW,
        cssH: ctx.cssH,
        scale: ctx.scale,
        candidates: ctx.candidates,
        agent: ctx.origin === "agent",
        accel: accel,
      };
    });
    /* 候选窗口（Z 序）单独一条：窗口枚举比抓屏慢一点点，不等它 —— 页面拿到冻结画面先能框选，
       悬停高亮等这条回来再补。等不到（枚举失败）就回空数组，行为退回「只能自己拖框」。 */
    ipcMain.handle(CH.candidates, async (e) => {
      if (!fromMine(e) || !ctx) return { ok: false, candidates: [], error: t("截图已结束") };
      const pend = ctx.windowsReady;
      if (pend && typeof pend.then === "function") {
        try {
          await Promise.race([pend, new Promise((r) => setTimeout(r, 4000))]);
        } catch (_) {}
      }
      return { ok: true, candidates: (ctx && ctx.candidates) || [] };
    });
    /* 标完：写 PNG → 生成 Markdown → 写剪贴板 → 收口（关窗交给渲染层，它要先把「已复制」显示完） */
    ipcMain.handle(CH.finish, (e, payload) => {
      if (!fromMine(e) || !ctx) return { ok: false, error: t("截图已结束") };
      const p = payload && typeof payload === "object" ? payload : {};
      const buf = dataUrlToBuffer(p.dataUrl);
      if (!buf || !buf.length) return { ok: false, error: t("导出的图片是空的") };
      const dir = outDirAbs();
      if (!dir) return { ok: false, error: t("截图目录不可用") };
      const dest = path.join(dir, shotFileName(Date.now()));
      try {
        fs.writeFileSync(dest, buf);
      } catch (err) {
        return { ok: false, error: t("截图写盘失败：") + ((err && err.message) || String(err)) };
      }
      const imageW = Math.round(Number(p.imageW) || 0) || ctx.crop.w;
      const imageH = Math.round(Number(p.imageH) || 0) || ctx.crop.h;
      const notes = Array.isArray(p.notes) ? p.notes : [];
      const markdown = buildMarkdown({ imagePath: dest, imageW: imageW, imageH: imageH, notes: notes });
      let copied = false;
      try {
        if (clipboard && typeof clipboard.writeText === "function") {
          clipboard.writeText(markdown);
          copied = true;
        }
      } catch (_) {
        copied = false;
      }
      const result = {
        ok: true,
        path: dest,
        bytes: buf.length,
        width: imageW,
        height: imageH,
        notes: notes,
        markdown: markdown,
        copied: copied,
        agent: ctx ? ctx.origin === "agent" : false,
      };
      settle(result);
      return result;
    });
    /* 另存为：弹系统的保存对话框，用户自己挑目录与文件名（默认仍落在 captures/ 的那个文件名）。
       存完**不收口、不关窗** —— 用户可能接着标；只有 finish / close / cancel 才收口。
       PNG 内容由渲染层给：与「完成并复制」是同一份像素（只选区内、文字与编号已烧入）。 */
    ipcMain.handle(CH.saveAs, async (e, payload) => {
      if (!fromMine(e) || !ctx) return { ok: false, error: t("截图已结束") };
      const p = payload && typeof payload === "object" ? payload : {};
      const buf = dataUrlToBuffer(p.dataUrl);
      if (!buf || !buf.length) return { ok: false, error: t("导出的图片是空的") };
      if (!dialog || typeof dialog.showSaveDialog !== "function")
        return { ok: false, error: t("这个环境不支持另存为") };
      const defaultPath = path.join(outDirAbs(), shotFileName(Date.now()));
      const opts = {
        title: t("保存截图"),
        defaultPath: defaultPath,
        filters: [{ name: t("PNG 图片"), extensions: ["png"] }],
      };
      let r = null;
      try {
        r = alive() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
      if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true, path: "" };
      /* 内容永远是 PNG：用户把后缀删了 / 改成别的，就按 PNG 补回去（别写出一个名不副实的文件） */
      let dest = String(r.filePath);
      if (!/\.png$/i.test(dest)) dest = dest.replace(/\.[^\\/.]{1,6}$/, "") + ".png";
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
      } catch (err) {
        return { ok: false, error: t("截图写盘失败：") + ((err && err.message) || String(err)) };
      }
      return {
        ok: true,
        path: dest,
        bytes: buf.length,
        width: Math.round(Number(p.imageW) || 0) || 0,
        height: Math.round(Number(p.imageH) || 0) || 0,
      };
    });
    /* 保存成功那条回执上的「打开文件夹」：只认渲染层刚拿到的那个路径，别的什么也不做 */
    ipcMain.handle(CH.reveal, async (e, payload) => {
      if (!fromMine(e)) return { ok: false };
      const raw = payload && typeof payload === "object" ? payload.path : payload;
      const target = String(raw == null ? "" : raw).trim();
      if (!target) return { ok: false, error: t("没有可打开的文件") };
      if (!reveal) return { ok: false, error: t("这个环境不支持打开文件夹") };
      try {
        return await reveal(target);
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    });
    ipcMain.handle(CH.close, (e) => {
      if (!fromMine(e)) return { ok: false };
      teardown();
      settle({ ok: false, canceled: true, path: "" });
      return { ok: true };
    });
    ipcMain.handle(CH.cancel, (e) => {
      if (!fromMine(e)) return { ok: false };
      teardown();
      settle({ ok: false, canceled: true, path: "" });
      return { ok: true };
    });
  }

  return {
    ACCEL: accel,
    CH: CH,
    hotkey: () => Object.assign({}, hotkeyState),
    registerHotkey: registerHotkey,
    unregisterHotkey: unregisterHotkey,
    registerIpc: registerIpc,
    open: open,
    /* Agent 入口：先问一句（用户可以拒，拒了绝不动他的屏幕），再等用户标完回结果
       （关闭 / 取消 → { ok:false, canceled:true }；拒绝 → 追加 declined:true）。
       confirmed:true = 渲染层那只对话框（写一句话 + 可选图片路径）已经问过用户，
       这里不再弹第二只原生询问窗 —— 否则用户要被问两遍。 */
    request: async (options) => {
      const opts = Object.assign({ origin: "agent" }, options || {});
      if (opts.confirmed !== true && typeof d.confirm === "function") {
        let yes = false;
        try {
          yes = await d.confirm(opts.reason || "");
        } catch (_) {
          yes = false;
        }
        if (!yes) return { ok: false, canceled: true, declined: true, path: "" };
      }
      return open(opts);
    },
    isOpen: alive,
    close: () => {
      teardown();
      settle({ ok: false, canceled: true, path: "" });
    },
    /* 只读状态：给「快捷键是否注册成功」这类自检用 */
    pendingAgent: () => !!pending,
  };
}

module.exports = {
  DEFAULT_ACCEL,
  CH,
  KIND_LABELS,
  nativeHandleOf,
  kindLabel,
  stampOf,
  normRect,
  clampRect,
  rectsIntersect,
  cropRectOf,
  mapCandidates,
  noteLine,
  buildMarkdown,
  shotFileName,
  dataUrlToBuffer,
  createScreenshotTool,
};

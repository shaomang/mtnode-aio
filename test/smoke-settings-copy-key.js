"use strict";
/* 复制按钮「点了报错 / 复制失败」回归（设置页 API Key + 画布节点输出 + 全仓出口唯一性）
 *   跑法：node test/smoke-settings-copy-key.js
 *
 * 症状（用户报过两次，同一根因）：
 *   ① 设置 · 提供商里 MTNode 中转服务卡上的 API Key 复制按钮，点了弹「复制失败」；
 *   ② 画布节点 OUTPUT 面板右上角的「复制」，点了直接报错、剪贴板里什么都没有。
 * 根因（真跑出来的，不是猜）：主窗的会话权限闸只放行 media 一类 ——
 *   main.js 的 setPermissionRequestHandler / setPermissionCheckHandler 对 clipboard-write
 *   一律拒，而 Chromium 只在「文档 focused + 用户手势」时才跳过权限复查，窗口失焦 / 异步之后
 *   就变成 NotAllowedError；渲染层各处当时只写 navigator.clipboard.writeText 一条路，
 *   catch 里一律弹「复制失败」（没 catch 的就只剩一条 unhandled rejection）。
 * 修法（本轮，用户拷问定下的口径）：
 *   · 渲染层收敛出**唯一出口** renderer/app-clipboard.js：
 *     appClipboardWrite（三级链路 ① navigator.clipboard.writeText → ② preload 桥
 *     window.api.clipboardWriteText → ③ document.execCommand 兜底，返回 { ok, via, error }）
 *     + appClipboardCopy（成功弹各按钮原有文案、失败弹准确原因「复制失败：<三级原因>」）；
 *   · 设置页 settingsClipboardWrite、会话 dshClipboardWrite、文件预览 fvPeekCopy 都变薄封装指向它；
 *   · 主进程权限闸另外放行本机页面的 clipboard-sanitized-write（① 因此也能直接用），
 *     仍不放 clipboard-read，http(s) 页面照旧一律拒。
 *
 * 覆盖：
 *   [0] 源码口径：全渲染层再无裸调剪贴板，节点输出两处复制都走出口
 *   [1] 真跑助手：① 成功即回（不惊动桥与兜底）
 *   [2] ① 被权限闸拒（NotAllowedError）→ ② 桥接管成功（不再弹「复制失败」）
 *   [3] 桥缺失 / navigator 整个不可用 → ③ execCommand 兜底成功
 *   [4] 桥回了 { ok:false } → 继续退到 ③
 *   [5] 三级全废 → { ok:false } + 准确原因（调用方据此弹 err 文案；中英词条齐备）
 *   [6] 端到端口径：权限闸放行 media + 本机页面的 clipboard 写 + ipcMain 真写系统剪贴板
 *   [7] 出口唯一性：renderer/*.js 里除 app-clipboard.js 外再无直连剪贴板（唯二例外有交代）
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const CLIP = read("renderer/app-clipboard.js");
const SETTINGS = read("renderer/app-settings.js");
const MAIN = read("main.js");

/* ── 最小 DOM 影子：只够三级链路 ③ 兜底用 ── */
function makeDom() {
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.style = {};
      this.value = "";
      this._focused = false;
      this._selected = false;
    }
    focus() {
      this._focused = true;
    }
    select() {
      this._selected = true;
    }
  }
  const body = new El("body");
  const kids = [];
  const document = {
    body,
    execCommand: null, /* 每个用例按需装 */
    createElement: (t) => new El(t),
  };
  body.appendChild = (c) => {
    kids.push(c);
    c.parentNode = body;
    return c;
  };
  body.removeChild = (c) => {
    const i = kids.indexOf(c);
    if (i >= 0) kids.splice(i, 1);
    return c;
  };
  document.__kids = kids;
  return document;
}

const document_ = makeDom();
const calls = { navigator: 0, ipc: 0, exec: 0 };
let mode = "navigator-ok";
/* 桥的应答：真桥（main.js 的 ipcMain "clipboard:writeText"）只回 { ok:true } / { ok:false }，
   这里就用这两种；NO_REPLY = 桥答不上来（undefined），用于钉「桥不确认就不许当成功」 */
const NO_REPLY = Symbol("no-reply");
const ipcReply = { current: { ok: true } };

const sandbox = {
  console,
  document: document_,
  navigator: {
    clipboard: {
      writeText: () => {
        calls.navigator++;
        if (mode === "navigator-ok") return Promise.resolve();
        /* 权限闸拒的样子：DOMException NotAllowedError */
        const e = new Error("Write permission denied.");
        e.name = "NotAllowedError";
        return Promise.reject(e);
      },
    },
  },
  window: {
    api: {
      clipboardWriteText: (t) => {
        calls.ipc++;
        calls.lastIpcText = t;
        /* 真桥（main.js 的 ipcMain "clipboard:writeText"）永远回 { ok:true } / { ok:false }；
           NO_REPLY 只在测试里表示「这次桥答不上来」（真桥不存在情景） */
        return Promise.resolve(
          ipcReply.current === NO_REPLY ? undefined : ipcReply.current,
        );
      },
    },
  },
  I18n: { t: (s) => String(s) },
};
vm.createContext(sandbox);
/* 同一份真源码跑进沙箱（不是抄一遍助手）：
   先 app-clipboard.js（唯一出口），再 app-settings.js（薄封装指它）。
   两份在真应用里也是相邻加载（index.html：app-clipboard.js 紧跟 app-inline-img.js、排在 app.js 前；
   app-settings.js 在后面），这里只为取到函数，顺序不影响判据。 */
vm.runInContext(CLIP, sandbox, { filename: "app-clipboard.js" });
vm.runInContext(SETTINGS, sandbox, { filename: "app-settings.js" });
const write = (t) => vm.runInContext("settingsClipboardWrite", sandbox)(t);
const direct = (t) => vm.runInContext("appClipboardWrite", sandbox)(t);

async function main() {
  console.log("[0] 源码口径：全渲染层再无裸调剪贴板，节点输出两处复制都走出口");
  ok(typeof write === "function", "沙箱里跑出了真 settingsClipboardWrite（取自 app-settings.js 源码）");
  ok(
    /function settingsClipboardWrite\(text\) \{\s*return appClipboardWrite\(text\);\s*\}/.test(SETTINGS),
    "settingsClipboardWrite 已收敛成薄封装：return appClipboardWrite(text)（历史三级链路整体搬去 app-clipboard.js）",
  );
  ok(
    CLIP.indexOf("function appClipboardWrite(") >= 0 &&
      CLIP.indexOf("function appClipboardCopy(") >= 0 &&
      CLIP.indexOf("function appClipboardFailureText(") >= 0,
    "唯一出口三个函数齐备：appClipboardWrite / appClipboardCopy / appClipboardFailureText",
  );
  ok(
    CLIP.indexOf("navigator") >= 0 &&
      CLIP.indexOf("window.api.clipboardWriteText") >= 0 &&
      CLIP.indexOf('document.execCommand("copy")') >= 0,
    "三级链路都在出口里：① navigator → ② preload 桥 → ③ execCommand",
  );
  const canvas = read("renderer/app-canvas.js");
  const outCopy = canvas.slice(
    canvas.indexOf('I18n.t("复制输出文本")'),
    canvas.indexOf('I18n.t("复制输出文本")') + 260,
  );
  ok(
    outCopy.indexOf("appClipboardCopy(outputTextOf(node)") >= 0 &&
      outCopy.indexOf("navigator.clipboard") < 0 &&
      outCopy.indexOf('I18n.t("已复制到剪贴板")') >= 0,
    "节点 OUTPUT 面板「复制」（用户报错的那一处）走 appClipboardCopy，成功文案仍是「已复制到剪贴板」",
  );
  const nodes = read("renderer/app-nodes.js");
  const browseCopy = nodes.slice(
    nodes.indexOf('copyBtn.title = I18n.t("复制输出中的全部文本")'),
    nodes.indexOf('copyBtn.title = I18n.t("复制输出中的全部文本")') + 400,
  );
  ok(
    browseCopy.indexOf("appClipboardCopy(txt, I18n.t(\"已复制\"))") >= 0 &&
      browseCopy.indexOf("navigator.clipboard") < 0,
    "「浏览」大窗底部的「复制文本」同样走出口（原来是裸调 + 没有失败分支）",
  );
  ok(
    nodes.indexOf('appClipboardCopy(pre.textContent, I18n.t("已复制摘要"))') >= 0 &&
      nodes.indexOf('appClipboardCopy(pre.textContent, I18n.t("已复制请求"))') >= 0,
    "「复制摘要」「复制请求」同源改造（成功文案不变）",
  );
  const html = read("renderer/index.html");
  const iClip = html.indexOf('src="app-clipboard.js"');
  const iApp = html.indexOf('src="app.js"');
  ok(
    iClip > 0 && iApp > 0 && iClip < iApp,
    "index.html 里 app-clipboard.js 排在 app.js 之前（全渲染层的公共出口）",
  );

  console.log("[1] ① navigator 成功：直接回，不惊动桥与兜底");
  mode = "navigator-ok";
  calls.navigator = calls.ipc = calls.exec = 0;
  let r = await write("hello");
  ok(r.ok === true && r.via === "navigator", "回 { ok:true, via:'navigator' }");
  ok(calls.ipc === 0 && calls.exec === 0, "桥与 execCommand 都没被调用（成功即收）");

  console.log("[2] ① 被权限闸拒 → ② preload 桥接管");
  mode = "navigator-denied";
  calls.navigator = calls.ipc = calls.exec = 0;
  ipcReply.current = { ok: true };
  r = await write("mtnode-relay-key-48hex");
  ok(calls.navigator === 1 && calls.ipc === 1, "navigator 失败后确实退到桥（各调 1 次）");
  ok(r.ok === true && r.via === "ipc", "回 { ok:true, via:'ipc' } —— 用户看到的是「已复制」而不是「复制失败」");
  ok(calls.lastIpcText === "mtnode-relay-key-48hex", "桥拿到的就是那一串 Key（原样，未截断 / 未加工）");
  ok(calls.exec === 0, "桥成功就不用 execCommand 兜底");

  console.log("[3] 桥不存在 / navigator 整个不可用 → ③ execCommand 兜底");
  mode = "navigator-denied";
  calls.navigator = calls.ipc = calls.exec = 0;
  ipcReply.current = NO_REPLY; /* 桥答不上来：三级里只剩 ③ 可用 */
  document_.execCommand = () => {
    calls.exec++;
    return true;
  };
  r = await write("only-exec");
  ok(
    calls.exec === 1 && r.ok === true && r.via === "exec",
    "③ 兜底成功：{ ok:true, via:'exec' }（桥答不上来时没有被误判成成功）",
  );
  ok(document_.__kids.length === 0, "临时 textarea 用完就摘掉（不留 DOM 垃圾）");
  /* navigator.clipboard 整个不可用（老环境 / 桥缺失）：只能走 ③
     注：沙箱上下文里的 navigator 与外面这个对象是同一份引用，但**属性要就地改**
     （把 sandbox.navigator.clipboard 整个换掉，上下文里那份仍是老对象）。 */
  const clipboardObj = sandbox.navigator.clipboard;
  const savedWriteText = clipboardObj.writeText;
  clipboardObj.writeText = null;
  calls.navigator = calls.ipc = calls.exec = 0;
  const savedReply = ipcReply.current;
  ipcReply.current = { ok: true };
  r = await write("no-navigator");
  ok(calls.navigator === 0 && calls.ipc === 1 && r.via === "ipc", "无 navigator.clipboard 时直接走桥");
  ipcReply.current = NO_REPLY;
  sandbox.window.api.clipboardWriteText = null;
  r = await write("no-bridge-either");
  ok(
    r.ok === true && r.via === "exec",
    "桥也不在（window.api 上没这个函数）→ 兜底 execCommand 仍能复制成功",
  );
  clipboardObj.writeText = savedWriteText;
  sandbox.window.api.clipboardWriteText = (t) => {
    calls.ipc++;
    calls.lastIpcText = t;
    return Promise.resolve(ipcReply.current === NO_REPLY ? undefined : ipcReply.current);
  };
  ipcReply.current = savedReply;

  console.log("[4] 桥回 { ok:false }（真写失败）→ 继续退到 ③");
  mode = "navigator-denied";
  calls.navigator = calls.ipc = calls.exec = 0;
  ipcReply.current = { ok: false, error: "clipboard busy" };
  document_.execCommand = () => {
    calls.exec++;
    return true;
  };
  r = await write("ipc-says-no");
  ok(calls.ipc === 1 && calls.exec === 1, "桥失败后 execCommand 接上（两条都试过）");
  ok(r.ok === true && r.via === "exec", "最终仍成功（桥报错不等于复制不了）");

  console.log("[5] 三级全废：只能如实报失败 + 给出准确原因");
  mode = "navigator-denied";
  calls.navigator = calls.ipc = calls.exec = 0;
  ipcReply.current = { ok: false, error: "clipboard busy" };
  document_.execCommand = () => {
    calls.exec++;
    return false; /* execCommand 也拒 */
  };
  r = await write("all-dead");
  ok(r.ok === false, "三级全废 → { ok:false }（调用方据此弹 err 文案）");
  ok(!!r.error, "带回 error 说明（不吞错）");
  ok(
    String(r.error).indexOf("navigator") >= 0 &&
      String(r.error).indexOf("bridge") >= 0 &&
      String(r.error).indexOf("exec") >= 0,
    "失败原因把三级各自的错都串上（哪一级被拒、拒成什么样都留痕）：" + JSON.stringify(String(r.error)),
  );
  const failureText = vm.runInContext("appClipboardFailureText", sandbox)(r);
  ok(
    failureText.indexOf("复制失败：") === 0 && failureText.length > 5,
    "文案口径 = 「复制失败：<准确原因>」（不再是光秃秃一句「复制失败」）",
  );
  const i18n = read("renderer/i18n.js");
  ok(
    i18n.indexOf('"复制失败，请手动选中后按 Ctrl+C 复制": "Copy failed') >= 0 &&
      i18n.indexOf('"复制失败：": "Copy failed: ') >= 0 &&
      i18n.indexOf('"未知原因": "unknown reason"') >= 0,
    "i18n 中英词条齐备（复制失败：/ 未知原因 / 手动选中后按 Ctrl+C 复制）",
  );
  document_.execCommand = () => true;

  console.log("[6] 端到端口径：权限闸放行 media + 本机页面的剪贴板写，且真写系统剪贴板");
  const gate = MAIN.slice(
    MAIN.indexOf("setPermissionRequestHandler"),
    MAIN.indexOf("setPermissionRequestHandler") + 1200,
  );
  ok(
    /const MEDIA_PERMISSIONS = new Set\(\["media", "audioCapture", "videoCapture"\]\)/.test(MAIN),
    "main.js 的媒体放行集合仍是 media / audioCapture / videoCapture（没被顺手放开）",
  );
  ok(
    /const CLIPBOARD_PERMISSIONS = new Set\(\["clipboard-sanitized-write"\]\)/.test(MAIN),
    "新放行集合只含 clipboard-sanitized-write（异步写剪贴板）",
  );
  ok(
    !/new Set\(\[[^\]]*clipboard-read/.test(MAIN),
    "clipboard-read 不在任何放行集合里（读剪贴板是另一件事，本轮不放开）",
  );
  ok(
    gate.indexOf("callback(permissionAllowed(permission) && isLocalPage(url))") >= 0 &&
      gate.indexOf("return permissionAllowed(permission) && isLocalPage(url)") >= 0,
    "request / check 两个 handler 都按「放行集合 + 只认本机页面」判（http(s) 页面照旧一律拒）",
  );
  const ipcHandler = MAIN.slice(
    MAIN.indexOf('ipcMain.handle("clipboard:writeText"'),
    MAIN.indexOf('ipcMain.handle("clipboard:writeText"') + 200,
  );
  ok(
    ipcHandler.indexOf("clipboard.writeText(String(text") >= 0 &&
      ipcHandler.indexOf("return { ok: true }") >= 0,
    "ipcMain「clipboard:writeText」用 electron clipboard 真写，成功回 { ok:true }",
  );
  const preload = read("preload.js");
  ok(
    /clipboardWriteText:\s*\(text\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]clipboard:writeText['"]\s*,\s*text\s*\)/.test(
      preload,
    ),
    "preload 桥 clipboardWriteText 已暴露给渲染层（出口 ② 有桥可走）",
  );

  console.log("[7] 出口唯一性：renderer/*.js 里只有 app-clipboard.js 直连剪贴板");
  /* 注释先摘掉再扫（注释里提到 API 名不算违规）：行注释用 [^:] 避开 https:// */
  const stripComments = (s) =>
    String(s).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const dir = path.join(__dirname, "..", "renderer");
  const offenders = [];
  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith(".js") || n === "app-clipboard.js") continue;
    let src = stripComments(fs.readFileSync(path.join(dir, n), "utf8"));
    if (n === "app.js") {
      /* 唯一的有意例外：节点粘贴板失效监视器 watchTextCopyOutlets 给这两个出口各包一层
         （包的是出口本身，不是绕过出口去复制）。把它整段摘掉再扫。 */
      const a = src.indexOf("function watchTextCopyOutlets");
      const b = src.indexOf("})();", a);
      if (a >= 0 && b > a) src = src.slice(0, a) + src.slice(b);
      else ok(false, "app.js 里找不到 watchTextCopyOutlets（白名单失效，需要重新确认这条例外）");
    }
    if (/navigator\.clipboard|clipboardWriteText/.test(src)) offenders.push(n);
  }
  ok(
    offenders.length === 0,
    "除 app-clipboard.js 外，渲染层再无直连剪贴板的文件（违规：" + (offenders.join(", ") || "无") + "）",
  );
  const directR = await direct("via-outlet");
  ok(directR.ok === true, "appClipboardWrite 直接被调用也正常（出口本身可用）");
}

main()
  .catch((e) => {
    fails++;
    console.log("FAIL  异常：" + ((e && e.stack) || e));
  })
  .then(() => {
    console.log("");
    if (fails) {
      console.log("✗ " + fails + " / " + checks + " 项失败");
      process.exitCode = 1;
    } else {
      console.log("✓ 全部 " + checks + " 项通过");
    }
  });

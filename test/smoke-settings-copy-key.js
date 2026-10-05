"use strict";
/* 设置页「API Key / 中转 Key 复制失败」回归 —— 纯 Node、零依赖、不启动 Electron、不碰真实 %APPDATA%
 *   跑法：node test/smoke-settings-copy-key.js
 *
 * 症状（用户报）：设置 · 提供商里 MTNode 中转服务卡上的 API Key 复制按钮，点了弹「复制失败」。
 * 根因（真跑出来的，不是猜）：主窗的会话权限闸只放行 media 一类 ——
 *   main.js 的 setPermissionRequestHandler / setPermissionCheckHandler 对 clipboard-write
 *   一律 callback(false)（/ setPermissionCheckHandler 回 false），而 Chromium 只在
 *   「文档 focused + 用户手势」时才跳过权限复查，窗口失焦 / 异步之后就变成
 *   NotAllowedError；渲染层当时只有 navigator.clipboard.writeText 一条路，catch 里
 *   一律弹「复制失败」。
 * 修法：设置页统一走 settingsClipboardWrite（app-settings.js）
 *   ① navigator.clipboard.writeText → ② preload 桥 window.api.clipboardWriteText
 *   （→ ipcMain "clipboard:writeText" → electron clipboard.writeText，不过权限闸）
 *   → ③ document.execCommand("copy") 兜底；三级全废才提示「手动选中后按 Ctrl+C」。
 *
 * 覆盖：
 *   [0] 源码口径：app-settings.js 里已无裸 navigator.clipboard.writeText，两个复制按钮都走助手
 *   [1] 真跑助手：① 成功即回（不惊动桥与兜底）
 *   [2] ① 被权限闸拒（NotAllowedError）→ ② 桥接管成功（不再弹「复制失败」）
 *   [3] 桥缺失 / navigator 整个不可用 → ③ execCommand 兜底成功
 *   [4] 桥回了 { ok:false } → 继续退到 ③
 *   [5] 三级全废 → { ok:false }，调用方据此给「手动选中后按 Ctrl+C」文案（i18n 中英齐备）
 *   [6] 端到端口径：main.js 的权限闸真的只放行 media + ipcMain「clipboard:writeText」真写系统剪贴板
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
const SETTINGS = read("renderer/app-settings.js");
const MAIN = read("main.js");

/* ── 最小 DOM 影子：只够 settingsClipboardWrite 的 ③ 兜底用 ── */
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
        );      },
    },
  },
  I18n: { t: (s) => String(s) },
};
vm.createContext(sandbox);
/* 整份 app-settings.js 在沙箱里跑（与真应用同一份代码，不是抄一遍助手）：
   顶层只有函数 / 变量声明，不落 DOM —— 与 smoke-provider-models.js 同一做法。 */
vm.runInContext(SETTINGS, sandbox, { filename: "app-settings.js" });
const write = (t) => vm.runInContext("settingsClipboardWrite", sandbox)(t);

async function main() {
  console.log("[0] 源码口径：复制按钮不再直连 navigator.clipboard");
  ok(typeof write === "function", "沙箱里跑出了真 settingsClipboardWrite（取自 app-settings.js 源码）");
  /* 口径：除助手自身那一条「探测 navigator.clipboard」外，不该再有别处直连写剪贴板 */
  const helperEnd = SETTINGS.indexOf("/* 「打开设置并直接滚到某一节」的请求位");
  ok(helperEnd > 0, "助手 settingsClipboardWrite 就在 app-settings.js 顶部（可切出边界）");
  const afterHelper = SETTINGS.slice(helperEnd);
  ok(
    SETTINGS.indexOf("navigator.clipboard\n        .writeText") < 0 &&
      SETTINGS.indexOf("navigator.clipboard\r\n        .writeText") < 0 &&
      afterHelper.indexOf("navigator.clipboard") < 0,
    "助手之后（两个复制按钮所在处）再无任何 navigator.clipboard 直连（老写法全清）",
  );
  const relayBtn = SETTINGS.slice(
    SETTINGS.indexOf('cp.title = I18n.t("复制中转 Key 到剪贴板")'),
    SETTINGS.indexOf('cp.title = I18n.t("复制中转 Key 到剪贴板")') + 900,
  );
  ok(
    relayBtn.indexOf("settingsClipboardWrite(keyText)") >= 0 &&
      relayBtn.indexOf("复制失败，请手动选中后按 Ctrl+C 复制") >= 0,
    "中转 Key 卡「复制」按钮走 settingsClipboardWrite，失败文案是「手动选中后按 Ctrl+C」",
  );
  const keyBtn = SETTINGS.slice(
    SETTINGS.indexOf('cp.title = I18n.t("复制 API Key 到剪贴板")'),
    SETTINGS.indexOf('cp.title = I18n.t("复制 API Key 到剪贴板")') + 700,
  );
  ok(
    keyBtn.indexOf("settingsClipboardWrite(v)") >= 0 &&
      keyBtn.indexOf("复制失败，请手动选中后按 Ctrl+C 复制") >= 0,
    "普通服务商卡「复制」按钮同样走助手（同一个根因，一并修）",
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

  console.log("[5] 三级全废：只能如实报失败 + 教用户手动复制");
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
  const i18n = read("renderer/i18n.js");
  ok(
    i18n.indexOf('"复制失败，请手动选中后按 Ctrl+C 复制": "Copy failed') >= 0,
    "i18n 中英词条齐备：复制失败，请手动选中后按 Ctrl+C 复制",
  );
  document_.execCommand = () => true;

  console.log("[6] 端到端口径：权限闸只放行 media + 主进程真写系统剪贴板");
  const gate = MAIN.slice(
    MAIN.indexOf("setPermissionRequestHandler"),
    MAIN.indexOf("setPermissionRequestHandler") + 700,
  );
  ok(
    /const MEDIA_PERMISSIONS = new Set\(\["media", "audioCapture", "videoCapture"\]\)/.test(MAIN),
    "main.js 的权限放行集合只有 media / audioCapture / videoCapture（剪贴板不在其中）",
  );
  ok(
    gate.indexOf("callback(MEDIA_PERMISSIONS.has(permission) && isLocalPage(url))") >= 0 &&
      gate.indexOf("return MEDIA_PERMISSIONS.has(permission) && isLocalPage(url)") >= 0,
    "request / check 两个 handler 对 clipboard-write 都回 false（这就是「复制失败」的来源）",
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
    "preload 桥 clipboardWriteText 已暴露给渲染层（助手 ② 有桥可走）",
  );
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

"use strict";
/* ============ 剪贴板「写」的唯一出口（全渲染层共用） ============
   背景（两个用户报过的同一类 bug）：设置页的「API Key 复制」、画布节点 OUTPUT 面板的
   「复制」都出现过「点一下按钮就报错 / 弹复制失败」。根因不在按钮本身 ——
   主窗的会话权限闸（main.js 的 setPermissionRequestHandler / setPermissionCheckHandler）
   只放行 media 一类，clipboard-write 一律拒，**裸调 navigator.clipboard.writeText 的
   地方在权限复查时只会拿到一个 NotAllowedError**，谁都得自己再想一遍退路。
   于是收敛成这一个出口：任何要往系统剪贴板写字的代码都调 appClipboardWrite / appClipboardCopy，
   不许再裸调 navigator.clipboard（回归口径见 test/smoke-settings-copy-key.js）。

   三级链路（① 通了就不惊动后面两级）：
     ① navigator.clipboard.writeText —— Web 标准 API，focused + 用户手势时最快；
     ② preload 桥 window.api.clipboardWriteText → ipcMain "clipboard:writeText"
        （electron clipboard.writeText，**不过权限闸**，是权限受限时唯一稳的路）；
     ③ document.execCommand("copy") 兜底 —— 桥缺失 / 老 Electron 的最后退路。
     （main.js 的权限闸本轮另外放行了本机页面的 clipboard-sanitized-write，① 因此也能直接用；
       但一级被拒仍要能退下去，所以三级链路照留。）

   返回 Promise<{ ok, via, error }>：via = "navigator" | "ipc" | "exec" | "none"，
   失败时 error 把三级的失败原因串起来（准确原因，不吞错）。
   调用方据此决定 toast，**绝不凭 catch 猜「复制失败」，也绝不把拿不到 ok 当成功**。

   加载顺序：必须排在所有调用它的文件之前（index.html 里紧跟 app-inline-img.js、排在 app.js 前）。
   本文件不依赖任何别的渲染层模块（I18n / toast 都在调用期取，且只用在 appClipboardCopy 里）。 */
function appClipboardWrite(text) {
  const txt = String(text == null ? "" : text);
  /* 全废时拼给用户看的原因串：每一级各记一条，谁被拒、拒成什么样都留痕 */
  const reasons = [];
  const why = (err) => {
    if (!err) return "unknown";
    const n = err && err.name ? err.name + ": " : "";
    return n + ((err && err.message) || String(err));
  };
  const failed = () => ({
    ok: false,
    via: "none",
    error: reasons.join(" | ") || "no clipboard route",
  });

  /* ③ execCommand 兜底：临时 textarea + select + copy，用完立刻摘掉 */
  const execCopy = () => {
    try {
      if (!document.body || !document.execCommand) {
        reasons.push("exec: 不可用");
        return Promise.resolve(failed());
      }
      const ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const done = document.execCommand("copy");
      document.body.removeChild(ta);
      if (done) return Promise.resolve({ ok: true, via: "exec" });
      reasons.push("exec: execCommand refused");
      return Promise.resolve(failed());
    } catch (err) {
      reasons.push("exec: " + why(err));
      return Promise.resolve(failed());
    }
  };

  /* ② preload 桥：不过权限闸，权限受限时唯一稳的路。
     桥**不存在**时回 null（不许把 null 当成功：它会顺着 obj.ok 的读法变成「已成功」） */
  const ipcCopy = () => {
    if (!(typeof window !== "undefined" && window.api && typeof window.api.clipboardWriteText === "function")) {
      reasons.push("bridge: 未暴露");
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(window.api.clipboardWriteText(txt)).then((r) => {
        /* 只有显式 { ok:true } 算成功：桥答不上来（undefined/null/别的形状）一律当失败往下退 */
        if (r && r.ok === true) return { ok: true, via: "ipc" };
        reasons.push("bridge: " + ((r && r.error) || "did not confirm"));
        return null;
      });
    } catch (err) {
      /* 桥自己抛了（极少）：继续往下退 */
      reasons.push("bridge: " + why(err));
      return Promise.resolve(null);
    }
  };

  /* ① Web 标准 API：成功就结束，失败只当「这条不通」，把错误交给下一级 */
  let first = null;
  try {
    const nb = typeof navigator !== "undefined" && navigator && navigator.clipboard;
    if (nb && typeof nb.writeText === "function") first = Promise.resolve(nb.writeText(txt));
    else reasons.push("navigator: 不可用");
  } catch (err) {
    reasons.push("navigator: " + why(err));
    first = null;
  }
  if (first)
    return first.then(
      () => ({ ok: true, via: "navigator" }),
      (err) => {
        reasons.push("navigator: " + why(err));
        return ipcCopy().then((r) => r || execCopy());
      },
    );
  return ipcCopy().then((r) => (r && r.ok ? r : execCopy()));
}

/* 失败文案：**给准确原因**（三级各自的失败原因串起来），不要笼统一句「复制失败」 */
function appClipboardFailureText(r) {
  return I18n.t("复制失败：") + ((r && r.error) || I18n.t("未知原因"));
}

/* 复制按钮的统一收尾：成功弹各按钮自己的文案（okText，不传就**不弹**——按钮自己会变状态），
   失败一律弹准确原因。调用方拿到 { ok, via, error }，需要额外动作（按钮变 ok / 关窗）接着 then。 */
function appClipboardCopy(text, okText) {
  return appClipboardWrite(text).then((r) => {
    if (typeof toast === "function") {
      if (!(r && r.ok)) toast(appClipboardFailureText(r), "err");
      else if (okText) toast(String(okText), "ok");
    }
    return r;
  });
}

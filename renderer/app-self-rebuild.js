/* ============================================================================
 * 状态栏「重新编译并重启」（renderer/app-self-rebuild.js + css/self-rebuild.css）
 * ----------------------------------------------------------------------------
 * 需求：应用右下角（版本号 #authorLink 左侧）给账号 ms2308 单独一枚按钮，
 * 点一下重新编译 MTNode 并重启 —— 不再依赖人工双击 compile.cmd。
 *
 * 为什么不是「在本进程里点一下就编译」：electron-builder 打包前会清空并重写
 * dist\win-unpacked，而应用正跑在那份产物里；且原 compile.cmd 是应用进程的
 * 子进程，应用一关脚本就被一起带走。所以真正的执行链在主进程里：
 *   IPC app:selfRebuild（main.js）→ `cmd /c start ...` 拉起一只**脱离本进程**的
 *   控制台窗 → 窗里跑 scripts\agent-rebuild.cmd --wait-pid <本进程 pid>：
 *   先等应用退出 → 杀残留 → node build.js --dir → 拉起新 exe。
 * 本文件只负责：显隐、确认、发起、回执。编译本身一个字都不在这里。
 *
 * 可见条件（两条同时满足，缺一即隐藏）：
 *   ① 打包版（app.isPackaged）—— 开发态 npm start 下杀 electron.exe 会把整棵
 *      dev 树（含当前调试会话）一起带走，那种环境根本不该出现这颗按钮；
 *   ② 登录用户名精确等于 ms2308（与研究视图同一口径：window.MTNodeAuth.state()）。
 *      未登录 / 换号 / 退出登录都会立刻隐藏（订阅 MTNodeAuth.onChange，另加
 *      1s / 3s 两次补同步，兜住 auth 首次异步刷新的竞态）。
 *
 * 交互：点一下先弹确认窗（说明「应用会立即关闭、编译约几分钟、完成后自动重启」），
 * 确认后才发起；调用期间按钮禁用，避免连点拉起第二只编译窗。
 * 口径：不改画布、不写持久化数据、不新增设置项。
 * ========================================================================== */
(function () {
  "use strict";

  const OWNER = "ms2308"; /* 只给这个账号（本机开发账号） */
  const BTN_ID = "btnSelfRebuild";

  let info = null; /* 主进程探测结果（脚本在不在 / 是否打包版 / 日志目录） */
  let probing = false;
  let running = false;

  function qid(id) {
    return document.getElementById(id);
  }

  /* I18n 是 renderer/i18n.js 顶层的全局词法绑定（不在 window 上），与 app-speakbar.js 同一写法 */
  function T(s) {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function") return I18n.t(s);
    } catch (_) {}
    return s;
  }

  function toastSafe(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind);
    } catch (_) {}
  }

  function ownerOk() {
    try {
      const A = window.MTNodeAuth;
      if (!A) return false;
      const snap = typeof A.state === "function" ? A.state() : A.state;
      const u = snap && snap.user;
      if (!u) return false;
      return String(u.username || "").trim().toLowerCase() === OWNER;
    } catch (_) {
      return false;
    }
  }

  /* 显隐：只改 hidden / style.display，不碰别的槽位（状态栏其余格照旧） */
  function apply() {
    const btn = qid(BTN_ID);
    if (!btn) return;
    const on = !!(info && info.available) && ownerOk();
    btn.hidden = !on;
    btn.style.display = on ? "" : "none";
    if (on) btn.title = T("重新编译并重启（仅本机开发账号）");
  }

  function probe() {
    if (probing) return;
    const api = window.api;
    if (!api || typeof api.selfRebuildInfo !== "function") return;
    probing = true;
    Promise.resolve(api.selfRebuildInfo())
      .then((r) => {
        info = r && r.ok !== false ? r : null;
      })
      .catch(() => {
        info = null;
      })
      .then(() => {
        probing = false;
        apply();
      });
  }

  function confirmText() {
    return T(
      "应用会立即关闭，编译在这只独立控制台窗里继续跑（约几分钟），完成后自动重启。编译失败时窗口会停住并保留日志。"
    );
  }

  function doRebuild() {
    const btn = qid(BTN_ID);
    if (running) return;
    if (!ownerOk() || !(info && info.available)) return;
    const api = window.api;
    if (!api || typeof api.selfRebuild !== "function") {
      toastSafe(T("重新编译入口不可用"), "err");
      return;
    }
    running = true;
    if (btn) btn.disabled = true;
    Promise.resolve(api.selfRebuild())
      .then((r) => {
        if (!r || !r.ok) {
          running = false;
          if (btn) btn.disabled = false;
          toastSafe((r && r.error) || T("重新编译失败"), "err");
          return;
        }
        /* 主进程拿到脚本的启动握手后才会退出应用（拿不到就不退，直接回错误）；
           这里只给一句反馈（带日志目录：万一控制台窗没起来，人至少知道去哪儿看编译输出） */
        var msg = T("已开始编译：应用即将关闭，跑完会自动重启。");
        if (r && r.logDir) msg += " " + T("日志目录：") + r.logDir;
        toastSafe(msg);
      })
      .catch((err) => {
        running = false;
        if (btn) btn.disabled = false;
        toastSafe((err && err.message) || T("重新编译失败"), "err");
      });
  }

  function askThenRebuild() {
    if (running) return;
    if (!ownerOk() || !(info && info.available)) return;
    const opts = {
      title: T("重新编译并重启"),
      okText: T("重新编译并重启"),
      cancelText: T("取消"),
    };
    let p;
    try {
      if (typeof confirmDialog === "function") p = confirmDialog(confirmText(), opts);
    } catch (_) {}
    if (!p || typeof p.then !== "function") {
      /* 兜底：确认窗不可用时不做任何事（绝不无确认地关掉应用） */
      return;
    }
    p.then((ok) => {
      if (ok) doRebuild();
    }).catch(() => {});
  }

  function wire() {
    const btn = qid(BTN_ID);
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.onclick = askThenRebuild;
      btn.hidden = true; /* 探测回来之前不露 */
    }
    probe();
    try {
      if (window.MTNodeAuth && typeof window.MTNodeAuth.onChange === "function") {
        window.MTNodeAuth.onChange(() => apply());
      }
    } catch (_) {}
    /* 启动竞态兜底：auth 首次 refresh 可能晚于本脚本，补两次纯显隐同步（幂等） */
    setTimeout(() => {
      probe();
      apply();
    }, 1000);
    setTimeout(apply, 3000);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", wire);
  else wire();

  /* 供冒烟 / 调试用：只读状态，不改任何东西 */
  window.MTSelfRebuild = {
    state: () => ({ info: info, probing: probing, running: running, owner: ownerOk() }),
    refresh: () => {
      probe();
      apply();
    },
  };
})();

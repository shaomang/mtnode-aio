/* close.js — 关窗收尾的脚手架：注册钩子 + 关窗/退出前的强制冲刷
 *
 * 三件事（顺序就是重要性）：
 *  1. window.AppClose.on(cb)：登记收尾动作（异步也行）。宿主关窗时会先发 apps:willClose，
 *     全部钩子跑完才真关（onWillClose 由 appHost 桥提供；没有桥时由本文件兜底）。
 *  2. window.AppClose.flush()：把「还没落盘的东西」立刻写完（app.js 注册的第一个钩子就是它）。
 *  3. 兜底：visibilitychange(hidden) / pagehide / beforeunload 各再冲刷一次 ——
 *     主程序退出、窗口被强制关闭时，willClose 可能来不及等，这几条是最后一道闸。
 *
 * 为什么不能只靠 beforeunload：窗口关掉时页面里的异步 IPC 不保证跑完。
 * 所以「宿主先请、应用后答」是主路（见 preload-app.js 的 onWillClose），本文件的兜底只是补网。
 */
(function () {
  "use strict";

  var hooks = [];
  var flushed = false; /* 本轮只允许最多一次「立刻冲刷」，避免三处事件叠着写三遍 */
  var onHostWillClose = false;

  var H = (function () {
    /* 新桥（应用窗口 preload-app.js）：window.appHost.onWillClose；
       老桥（插件窗口 preload-window.js）：window.pluginApi.onShown 那类里没有关闭钩子，
       所以老桥只走本文件的兜底路径。 */
    var h = window.appHost || null;
    if (h && typeof h.onWillClose === "function") {
      onHostWillClose = true;
      return h;
    }
    return h || window.pluginApi || window.forumApi || null;
  })();

  function isFn(v) {
    return typeof v === "function";
  }

  /** 登记一个收尾动作；返回退订函数 */
  function on(fn) {
    if (!isFn(fn)) return function () {};
    hooks.push(fn);
    return function () {
      var i = hooks.indexOf(fn);
      if (i >= 0) hooks.splice(i, 1);
    };
  }

  /** 依次跑完所有收尾动作（一个炸了不影响后面的），返回全部完成的 Promise */
  function run(reason) {
    var list = hooks.slice();
    var p = Promise.resolve();
    for (var i = 0; i < list.length; i++) {
      p = p.then(
        (function (fn) {
          return function () {
            try {
              return Promise.resolve(fn(reason || "close"));
            } catch (e) {
              return null;
            }
          };
        })(list[i]),
      );
    }
    return p.catch(function () {
      return null;
    });
  }

  /** 立刻冲刷（app.js 用它把自己的 store.flush 挂进来当第一个钩子） */
  function flush(reason) {
    if (flushed) return Promise.resolve(null);
    flushed = true;
    var p = run(reason || "flush");
    setTimeout(function () {
      flushed = false;
    }, 0);
    return p;
  }

  /* 宿主关窗（主路）：appHost.onWillClose 已经在桥里串行跑了所有登记的回调，
     并会回包给宿主；这里只要保证「钩子登记进桥」这一件事。 */
  if (onHostWillClose) {
    H.onWillClose(function () {
      return flush("host");
    });
  }

  /* 兜底网：页面被藏起来 / 正在离开 / 已经离开，各再冲一次（幂等） */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush("hidden");
  });
  window.addEventListener("pagehide", function () {
    flush("pagehide");
  });
  window.addEventListener("beforeunload", function () {
    /* 这里不能再 await（同步返回即走），但 flush() 已经把 IPC 发出去了：
       宿主那 1.5s 的等待窗口正是留给它的。 */
    flush("unload");
  });

  window.AppClose = {
    on: on,
    flush: flush,
    run: run,
    hooks: hooks,
    hostWillClose: onHostWillClose,
    /** 老桥 / 没桥时也能自己把关窗钩子跑起来：宿主发不了 willClose 的场合用它 */
    fire: flush,
  };
})();
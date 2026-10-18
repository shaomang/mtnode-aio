"use strict";
/**
 * 并排日志窗：只显示 console 流。
 * 托盘进程与 MTNode 主进程都注册了 breeze:consoleTail / breeze:* 通道，两边都能用。
 */
(() => {
  const logEl = document.getElementById("log");
  const pathEl = document.getElementById("path");
  const MAX_LINES = 4000;

  function append(line, cls) {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = line;
    logEl.appendChild(div);
    while (logEl.childNodes.length > MAX_LINES) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clsOf(line) {
    if (/\[err\]|error|failed|失败|Traceback/i.test(line)) return "err";
    if (/WARN|warn|提示|警告/i.test(line)) return "warn";
    if (/ready|complete|完成|就绪|success/i.test(line)) return "ok";
    return "";
  }

  const api = window.breezeApi || {};
  if (api.onConsole) {
    api.onConsole((d) => {
      const line = String((d && d.line) || "");
      if (!line) return;
      for (const l of line.split(/\r?\n/)) if (l.trim()) append(l, clsOf(l));
    });
  }
  if (api.consoleTail) {
    api.consoleTail(96 * 1024).then((r) => {
      const text = String((r && r.text) || "");
      for (const l of text.split(/\r?\n/)) if (l.trim()) append(l, clsOf(l));
    });
  }
  /* 清空 = 真清日志文件（truncate 到 0 字节），不是只清这块显示：
     主进程 / 托盘进程写完文件后广播 cleared，打开的日志窗就地清空。 */
  function clearView() {
    logEl.textContent = "";
  }
  const btnClear = document.getElementById("btnClear");
  if (btnClear) {
    btnClear.title = "清空日志文件（真删除，不只是清显示）";
    btnClear.addEventListener("click", async () => {
      let failed = "";
      if (api.consoleClear) {
        try {
          const r = await api.consoleClear();
          if (!r || !r.ok) failed = String((r && r.error) || "clear_failed");
        } catch (e) {
          failed = String((e && e.message) || e);
        }
      }
      /* 即使清文件失败，界面至少也要清掉（用户点的是「清空」） */
      clearView();
      if (failed && api.log) api.log("[console] 清空日志文件失败：" + failed);
    });
  }
  if (api.onConsoleCleared) api.onConsoleCleared(() => clearView());
  if (api.getStatus) {
    api.getStatus().then((st) => {
      if (st && st.consolePath) pathEl.textContent = st.consolePath;
    });
  }
})();

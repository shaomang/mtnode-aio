"use strict";

const api = window.llamaApi;
const consoleEl = document.getElementById("console");

/* 本文件自己的文件游标：视图中已有多少字符（增量轮询用它判断要不要重画）。
   「清空」真删了磁盘上的日志文件，这个游标必须一起复位，否则下一轮会把
   空内容当成「没变化」而继续显示旧文本。 */
let lastLen = 0;

function renderText(text, keepScroll) {
  if (!consoleEl) return;
  const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 48;
  consoleEl.textContent = String(text || "");
  if (!keepScroll || atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function logLine(s) {
  if (!consoleEl) return;
  consoleEl.textContent += String(s || "") + "\n";
  consoleEl.scrollTop = consoleEl.scrollHeight;
  lastLen = consoleEl.textContent.length;
}

/** 清空视图：把本地游标与 DOM 一起复位 */
function clearView() {
  if (consoleEl) consoleEl.textContent = "";
  lastLen = 0;
}

/** 清空日志：先真删日志文件内容（宿主 truncate 到 0 字节），再清 DOM 与本地游标。
    清盘失败也至少把显示清掉，并提示一句（绝不假装文件已清空）。 */
async function clearConsole() {
  let r = null;
  try {
    if (api && api.consoleClear) r = await api.consoleClear();
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  clearView();
  if (!r || !r.ok) {
    logLine("[clean] 清空日志文件失败（已清空显示）：" + ((r && r.error) || "consoleClear 不可用"));
    if (typeof window.alert === "function") {
      window.alert("清空日志文件失败（已清空显示）：" + ((r && r.error) || "consoleClear 不可用"));
    }
  }
}

const btnClear = document.getElementById("btnClear");
if (btnClear) {
  btnClear.title = "清空日志文件（真删除，不只是清显示）";
  btnClear.onclick = () => {
    clearConsole();
  };
}

if (api && api.onConsole) {
  api.onConsole((ev) => {
    if (ev && ev.line) logLine(ev.line);
  });
}

/* 宿主真删了日志文件（truncate）时广播：就地清空显示并复位本地游标 */
if (api && api.onConsoleCleared) {
  api.onConsoleCleared(() => clearView());
}

(async () => {
  if (!api || !api.consoleTail) return;
  try {
    const tail = await api.consoleTail(96 * 1024);
    if (tail && tail.text) renderText(tail.text);
  } catch {}
  lastLen = (consoleEl && consoleEl.textContent && consoleEl.textContent.length) || 0;
  setInterval(async () => {
    try {
      const t = await api.consoleTail(128 * 1024);
      if (!t || !t.text || !consoleEl) return;
      if (t.text.length === lastLen) return;
      lastLen = t.text.length;
      renderText(t.text, true);
    } catch {}
  }, 1200);
})();

"use strict";

const api = window.llamaApi;
const consoleEl = document.getElementById("console");

/* 本文件自己的文件游标：视图中已有多少字符（增量轮询用它判断要不要重画）。
   「清空」真删了磁盘上的日志文件，这个游标必须一起复位，否则下一轮会把
   空内容当成「没变化」而继续显示旧文本。 */
let lastLen = 0;
/* 视图里当前这份正文（长度判不出变化时的比较对象，见文件末尾的轮询） */
let lastText = "";

function renderText(text, keepScroll) {
  if (!consoleEl) return;
  const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 48;
  lastText = String(text || "");
  consoleEl.textContent = lastText;
  if (!keepScroll || atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function logLine(s) {
  if (!consoleEl) return;
  lastText = consoleEl.textContent + String(s || "") + "\n";
  consoleEl.textContent = lastText;
  consoleEl.scrollTop = consoleEl.scrollHeight;
  lastLen = lastText.length;
}

/** 清空视图：把本地游标与 DOM 一起复位 */
function clearView() {
  if (consoleEl) consoleEl.textContent = "";
  lastLen = 0;
  lastText = "";
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
  /* 轮询只按「正文有没有变」判断：旧写法拿 t.text.length === lastLen 当「没变化」，
     而 consoleTail 每次只回日志尾部 128KB —— 日志超过 128KB 之后长度被钉死在这个上限上，
     于是新行照进日志、界面却永远不再更新。比较对象必须是内容本身（lastText 见文件开头）。 */
  setInterval(async () => {
    try {
      const t = await api.consoleTail(128 * 1024);
      if (!t || !t.text || !consoleEl) return;
      if (t.text.length === lastLen && t.text === lastText) return;
      lastLen = t.text.length;
      renderText(t.text, true);
    } catch {}
  }, 1200);
})();

"use strict";

const api = window.ttsApi;
const logEl = document.getElementById("log");

/* 本文件自己的文件游标：视图里已经渲染过的文本长度（增量轮询用它判断要不要重画）。
   「清空」真删了磁盘上的日志文件，这个游标必须一起复位，否则空内容会被当成
   「没变化」而继续显示旧文本。 */
let lastLen = 0;

function appendLine(line, cls) {
  if (!logEl) return;
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = String(line || "");
  logEl.appendChild(div);
  while (logEl.childElementCount > 3000) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  lastLen += String(line || "").length + 1;
}

/** 清空视图：把本地游标与 DOM 一起复位 */
function clearView() {
  if (logEl) logEl.innerHTML = "";
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
    const msg = "清空日志文件失败（已清空显示）：" + ((r && r.error) || "consoleClear 不可用");
    appendLine(msg, "err");
    if (typeof window.alert === "function") window.alert(msg);
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
  api.onConsole((data) => {
    const line = data && data.line;
    if (!line) return;
    const isErr = /error|fail|异常|失败/i.test(String(line));
    appendLine(line, isErr ? "err" : "");
  });
}

/* 宿主真删了日志文件（truncate）时广播：就地清空显示并复位本地游标 */
if (api && api.onConsoleCleared) {
  api.onConsoleCleared(() => clearView());
}

(async () => {
  try {
    const r = await api.consoleTail(96 * 1024);
    if (r && r.ok && r.text) {
      const lines = r.text.split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-500)) {
        appendLine(line, /error|fail|异常|失败/i.test(line) ? "err" : "");
      }
    }
  } catch {}
})();

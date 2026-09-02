"use strict";

const api = window.ttsApi;
const logEl = document.getElementById("log");

function appendLine(line, cls) {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = String(line || "");
  logEl.appendChild(div);
  while (logEl.childElementCount > 3000) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

if (api && api.onConsole) {
  api.onConsole((data) => {
    const line = data && data.line;
    if (!line) return;
    const isErr = /error|fail|异常|失败/i.test(String(line));
    appendLine(line, isErr ? "err" : "");
  });
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

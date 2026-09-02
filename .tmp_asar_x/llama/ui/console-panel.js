"use strict";

const api = window.llamaApi;
const consoleEl = document.getElementById("console");

function logLine(s) {
  if (!consoleEl) return;
  consoleEl.textContent += String(s || "") + "\n";
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

document.getElementById("btnClear").onclick = () => {
  if (consoleEl) consoleEl.textContent = "";
};

if (api && api.onConsole) {
  api.onConsole((ev) => {
    if (ev && ev.line) logLine(ev.line);
  });
}

(async () => {
  if (!api || !api.consoleTail) return;
  try {
    const tail = await api.consoleTail(96 * 1024);
    if (tail && tail.text && consoleEl) {
      consoleEl.textContent = tail.text;
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  } catch {}
  let lastLen = (consoleEl && consoleEl.textContent && consoleEl.textContent.length) || 0;
  setInterval(async () => {
    try {
      const t = await api.consoleTail(128 * 1024);
      if (!t || !t.text || !consoleEl) return;
      if (t.text.length === lastLen) return;
      lastLen = t.text.length;
      const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 48;
      consoleEl.textContent = t.text;
      if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
    } catch {}
  }, 1200);
})();

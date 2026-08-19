"use strict";
(function () {
  const list = document.getElementById("list");
  const input = document.getElementById("input");
  const btnSend = document.getElementById("btnSend");
  const btnClose = document.getElementById("btnClose");
  const btnClear = document.getElementById("btnClear");
  const btnProv = document.getElementById("btnProv");
  const title = document.getElementById("title");
  const slotsEl = document.getElementById("slots");
  const provPanel = document.getElementById("provPanel");
  const provSel = document.getElementById("provSel");
  const modelSel = document.getElementById("modelSel");
  const provEmpty = document.getElementById("provEmpty");
  const provOk = document.getElementById("provOk");
  const provCancel = document.getElementById("provCancel");
  const api = window.petApi;
  let busy = false;
  let streamEl = null;
  let statusEl = null;
  let providers = [];
  let sessions = [];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inlineMd(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    t = t.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    t = t.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
    return t;
  }

  function isTableSepLine(line) {
    const t = String(line || "").trim();
    if (!t.includes("|") || !/-/.test(t)) return false;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (!cells.length) return false;
    return cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c) && /-/.test(c));
  }

  function isTableRowLine(line) {
    const t = String(line || "").trim();
    return t.includes("|") && !isTableSepLine(t);
  }

  function splitTableCells(line) {
    let t = String(line || "").trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    return t.split("|").map((c) => c.trim());
  }

  function looksLikeTableStart(lines, idx) {
    return (
      idx + 1 < lines.length &&
      isTableRowLine(lines[idx]) &&
      isTableSepLine(lines[idx + 1])
    );
  }

  function renderMarkdownLite(src) {
    const raw = String(src == null ? "" : src).replace(/\r\n/g, "\n");
    const fences = [];
    const withFences = raw.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
      const i = fences.length;
      fences.push("<pre><code>" + esc(String(code).replace(/\n$/, "")) + "</code></pre>");
      return "\n%%FENCE" + i + "%%\n";
    });
    const lines = withFences.split("\n");
    const out = [];
    let i = 0;
    const flushPara = (buf) => {
      const t = buf.join("\n").trim();
      if (t) out.push("<p>" + inlineMd(t).replace(/\n/g, "<br>") + "</p>");
      buf.length = 0;
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.trim().match(/^%%FENCE(\d+)%%$/);
      if (fence) {
        out.push(fences[Number(fence[1])] || "");
        i += 1;
        continue;
      }
      if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
        out.push("<hr>");
        i += 1;
        continue;
      }
      if (looksLikeTableStart(lines, i)) {
        const header = splitTableCells(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRowLine(lines[i])) {
          rows.push(splitTableCells(lines[i]));
          i += 1;
        }
        let html = "<table><thead><tr>";
        for (const cell of header) html += "<th>" + inlineMd(cell) + "</th>";
        html += "</tr></thead><tbody>";
        for (const row of rows) {
          html += "<tr>";
          for (let c = 0; c < header.length; c++) {
            html += "<td>" + inlineMd(row[c] != null ? row[c] : "") + "</td>";
          }
          html += "</tr>";
        }
        html += "</tbody></table>";
        out.push(html);
        continue;
      }
      const h = /^(#{1,4})\s+(.+)$/.exec(line);
      if (h) {
        const n = h[1].length;
        out.push("<h" + n + ">" + inlineMd(h[2]) + "</h" + n + ">");
        i += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ""));
          i += 1;
        }
        out.push("<blockquote>" + inlineMd(buf.join("\n")).replace(/\n/g, "<br>") + "</blockquote>");
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        out.push("<ul>");
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          out.push("<li>" + inlineMd(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>");
          i += 1;
        }
        out.push("</ul>");
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        out.push("<ol>");
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          out.push("<li>" + inlineMd(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
          i += 1;
        }
        out.push("</ol>");
        continue;
      }
      if (!String(line).trim()) {
        i += 1;
        continue;
      }
      const buf = [];
      while (
        i < lines.length &&
        String(lines[i]).trim() &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*---+\s*$/.test(lines[i]) &&
        !/^%%FENCE\d+%%$/.test(lines[i].trim()) &&
        !looksLikeTableStart(lines, i)
      ) {
        buf.push(lines[i]);
        i += 1;
      }
      flushPara(buf);
    }
    return out.join("") || "<p></p>";
  }

  function renderMarkdown(text) {
    try {
      const parse =
        window.marked &&
        (typeof window.marked.parse === "function"
          ? window.marked.parse.bind(window.marked)
          : typeof window.marked === "function"
            ? window.marked
            : null);
      if (typeof parse === "function") {
        let html = parse(String(text == null ? "" : text), { gfm: true, breaks: true });
        html = String(html).replace(/<a href="([^"]*)"/g, (m, u) => {
          if (/^(https?:|mailto:)/i.test(u) || u.charAt(0) === "#") return m;
          return '<a href="#" title="已阻止不安全链接"';
        });
        return html;
      }
    } catch (_) {}
    return renderMarkdownLite(text);
  }

  function setBubbleContent(bubble, role, text) {
    if (!bubble) return;
    if (role === "assistant") {
      bubble.classList.add("md");
      bubble.innerHTML = renderMarkdown(text);
    } else {
      bubble.classList.remove("md");
      bubble.textContent = text;
    }
  }

  function addMsg(role, text) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    if (role === "sys" || role === "status") {
      div.textContent = text;
    } else {
      const b = document.createElement("div");
      b.className = "bubble";
      setBubbleContent(b, role, text);
      div.appendChild(b);
    }
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    return div;
  }

  function setStatus(text) {
    const t = String(text || "").trim();
    if (!t) {
      if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);
      statusEl = null;
      return;
    }
    if (!statusEl || !statusEl.parentNode) {
      statusEl = addMsg("status", t);
    } else {
      statusEl.textContent = t;
    }
    list.scrollTop = list.scrollHeight;
  }

  function setBusy(v) {
    busy = !!v;
    btnSend.disabled = busy;
    input.disabled = busy;
  }

  function renderSlots(listSessions) {
    sessions = Array.isArray(listSessions) ? listSessions : sessions;
    if (!slotsEl) return;
    slotsEl.innerHTML = "";
    for (let i = 0; i < 10; i++) {
      const info = sessions.find((s) => s.index === i) || {
        index: i,
        hasMessages: false,
        active: false,
      };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "slot" +
        (info.hasMessages ? " has" : "") +
        (info.active ? " active" : "");
      btn.title = "会话 " + (i + 1) + (info.hasMessages ? "（有记录）" : "（空）");
      btn.onclick = () => switchSlot(i);
      slotsEl.appendChild(btn);
    }
  }

  function paintMessages(msgs) {
    list.innerHTML = "";
    streamEl = null;
    statusEl = null;
    const arr = Array.isArray(msgs) ? msgs : [];
    if (!arr.length) {
      addMsg("sys", "点下方槽位切换会话；🐋 选模型");
      return;
    }
    arr.forEach((m) =>
      addMsg(m.role === "user" ? "user" : "assistant", m.content || ""),
    );
  }

  function applyRunUi(state) {
    const busyNow = !!(state && state.busy);
    setBusy(busyNow);
    if (!busyNow) {
      setStatus("");
      return;
    }
    setStatus((state && state.status) || "努力思考中…");
    const streamText = state && state.streamingText;
    if (streamText) {
      if (!streamEl) streamEl = addMsg("assistant", "");
      const bubble = streamEl.querySelector(".bubble");
      setBubbleContent(bubble, "assistant", streamText);
      list.scrollTop = list.scrollHeight;
    }
  }

  async function switchSlot(i) {
    if (!api || !api.switchSession) return;
    const r = await api.switchSession(i);
    if (!r || !r.ok) return;
    renderSlots(r.sessions);
    paintMessages(r.messages);
    applyRunUi(r);
  }

  function fillModels(provId, selectedModel) {
    modelSel.innerHTML = "";
    const p = providers.find((x) => x.id === provId) || providers[0];
    const models = (p && p.models) || [];
    models.forEach((m) => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      if (selectedModel && m === selectedModel) o.selected = true;
      modelSel.appendChild(o);
    });
  }

  async function openProvPanel() {
    if (!api || !api.listProviders) return;
    const r = await api.listProviders();
    providers = (r && r.providers) || [];
    provSel.innerHTML = "";
    if (!providers.length) {
      provEmpty.style.display = "block";
      provSel.style.display = "none";
      modelSel.style.display = "none";
    } else {
      provEmpty.style.display = "none";
      provSel.style.display = "block";
      modelSel.style.display = "block";
      const curId = (r && r.chatProviderId) || providers[0].id;
      providers.forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name || p.id;
        if (p.id === curId) o.selected = true;
        provSel.appendChild(o);
      });
      fillModels(curId, (r && r.chatModel) || "");
    }
    provPanel.classList.add("open");
  }

  function closeProvPanel() {
    provPanel.classList.remove("open");
  }

  async function boot() {
    if (!api) {
      addMsg("sys", "ipc 未接通");
      return;
    }
    const cfg = await api.getConfig();
    const c = (cfg && cfg.config) || {};
    title.textContent = c.personaName || "BongoChat";
    const hist = await api.chatHistory();
    renderSlots((hist && hist.sessions) || []);
    paintMessages((hist && hist.messages) || []);
    applyRunUi(hist);
    if (api.onChatStatus) {
      api.onChatStatus((d) => setStatus(d && d.text));
    }
    if (api.onChatDelta) {
      api.onChatDelta((d) => {
        if (!d) return;
        setStatus("");
        if (d.reset || !streamEl) {
          streamEl = addMsg("assistant", "");
        }
        const bubble = streamEl.querySelector(".bubble");
        setBubbleContent(bubble, "assistant", d.text || "");
        list.scrollTop = list.scrollHeight;
      });
    }
    if (api.onChatDone) {
      api.onChatDone(async () => {
        streamEl = null;
        setStatus("");
        setBusy(false);
        if (api.listSessions) {
          const s = await api.listSessions();
          if (s && s.sessions) renderSlots(s.sessions);
        }
        input.focus();
      });
    }
    if (api.onChatError) {
      api.onChatError((d) => {
        streamEl = null;
        setStatus("");
        addMsg("sys", "错误：" + ((d && d.error) || "未知"));
        setBusy(false);
      });
    }
    if (api.onSessionsUpdated) {
      api.onSessionsUpdated((d) => {
        if (d && d.sessions) renderSlots(d.sessions);
      });
    }
  }

  async function send() {
    if (!api || busy) return;
    const t = (input.value || "").trim();
    if (!t) return;
    input.value = "";
    addMsg("user", t);
    setBusy(true);
    streamEl = null;
    setStatus("努力思考中…");
    const r = await api.chatSend(t);
    if (!r || !r.ok) {
      setStatus("");
      addMsg("sys", "发送失败：" + ((r && r.error) || "未知"));
      setBusy(false);
      return;
    }
    if (api.listSessions) {
      const s = await api.listSessions();
      if (s && s.sessions) renderSlots(s.sessions);
    }
  }

  btnSend.onclick = send;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  btnClose.onclick = () => api && api.toggleChat && api.toggleChat();
  btnClear.onclick = async () => {
    if (!api || busy) return;
    await api.chatClear();
    paintMessages([]);
    if (api.listSessions) {
      const s = await api.listSessions();
      if (s && s.sessions) renderSlots(s.sessions);
    }
  };
  if (btnProv) btnProv.onclick = () => openProvPanel();
  if (provCancel) provCancel.onclick = closeProvPanel;
  if (provSel) provSel.onchange = () => fillModels(provSel.value, "");
  if (provOk) {
    provOk.onclick = async () => {
      if (!api) return;
      if (providers.length) {
        await api.setConfig({
          chatProviderId: provSel.value,
          chatModel: modelSel.value,
        });
      }
      closeProvPanel();
    };
  }

  list.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault();
      window.open(href, "_blank");
    }
  });
  document.addEventListener("contextmenu", (e) => e.preventDefault(), true);
  boot();
})();

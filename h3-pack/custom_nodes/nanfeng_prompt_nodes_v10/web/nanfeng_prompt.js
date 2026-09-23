import { app } from "../../../scripts/app.js";

const ALIASES = [
  "@图片1", "@图片2", "@图片3",
  "@视频1", "@视频2", "@视频3",
  "@音频1", "@音频2", "@音频3",
];

function mediaInputName(alias) {
  return alias.slice(1);
}

function isConnected(node, alias) {
  const input = node.inputs?.find((item) => item.name === mediaInputName(alias));
  return input?.link != null;
}

function insertAtCaret(widget, text, replaceStart = null, replaceEnd = null) {
  const el = widget?.inputEl;
  if (!el) return;
  const start = replaceStart ?? el.selectionStart ?? String(widget.value ?? "").length;
  const end = replaceEnd ?? el.selectionEnd ?? start;
  const value = String(widget.value ?? "");
  const needsLeadingSpace = start > 0 && !/\s|\(|（/.test(value[start - 1]);
  const needsTrailingSpace = end < value.length && !/\s|\)|）|，|。|、/.test(value[end]);
  const inserted = `${needsLeadingSpace ? " " : ""}${text}${needsTrailingSpace ? " " : ""}`;
  const next = value.slice(0, start) + inserted + value.slice(end);
  widget.value = next;
  el.value = next;
  const caret = start + inserted.length;
  el.focus();
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function makePopup(node, widget) {
  const popup = document.createElement("div");
  popup.className = "nanfeng-mention-popup";
  Object.assign(popup.style, {
    position: "fixed", zIndex: "100000", display: "none",
    minWidth: "180px", maxHeight: "260px", overflowY: "auto",
    padding: "6px", border: "1px solid #555", borderRadius: "8px",
    background: "#202124", color: "#eee", boxShadow: "0 8px 26px #0009",
    font: "13px sans-serif",
  });
  document.body.appendChild(popup);

  const hide = () => { popup.style.display = "none"; };
  const show = (tokenStart, tokenEnd, query = "") => {
    popup.replaceChildren();
    const filtered = ALIASES.filter((alias) => alias.includes(query));
    for (const alias of filtered) {
      const connected = isConnected(node, alias);
      const row = document.createElement("div");
      row.textContent = `${alias}${connected ? "  ✓ 已连接" : "  ○ 未连接"}`;
      Object.assign(row.style, {
        padding: "7px 9px", borderRadius: "6px", cursor: connected ? "pointer" : "not-allowed",
        color: connected ? "#fff" : "#888", background: "transparent",
      });
      if (connected) {
        row.onmouseenter = () => { row.style.background = "#3b3d40"; };
        row.onmouseleave = () => { row.style.background = "transparent"; };
        row.onmousedown = (event) => {
          event.preventDefault();
          insertAtCaret(widget, alias, tokenStart, tokenEnd);
          hide();
        };
      }
      popup.appendChild(row);
    }
    if (!filtered.length) return hide();
    const rect = widget.inputEl.getBoundingClientRect();
    popup.style.left = `${Math.min(rect.left + 12, window.innerWidth - 210)}px`;
    popup.style.top = `${Math.min(rect.bottom - 8, window.innerHeight - 280)}px`;
    popup.style.display = "block";
  };

  const onInput = () => {
    const el = widget.inputEl;
    const caret = el.selectionStart ?? 0;
    const before = String(el.value ?? "").slice(0, caret);
    const match = before.match(/@(图片|视频|音频)?\d*$/);
    if (!match) return hide();
    show(caret - match[0].length, caret, match[0]);
  };
  widget.inputEl.addEventListener("input", onInput);
  widget.inputEl.addEventListener("blur", () => setTimeout(hide, 120));
  widget.inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });

  node.onRemoved = ((original) => function () {
    popup.remove();
    original?.apply(this, arguments);
  })(node.onRemoved);

  return { hide };
}

app.registerExtension({
  name: "NanFeng.PromptMentions",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "NanFengH3PromptDraft") return;
    const original = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = original?.apply(this, arguments);
      const promptWidget = this.widgets?.find((w) => w.name === "提示词");
      const insertWidget = this.widgets?.find((w) => w.name === "插入引用");
      if (!promptWidget?.inputEl || !insertWidget) return result;

      makePopup(this, promptWidget);
      let ready = false;
      setTimeout(() => { ready = true; }, 300);
      const previous = insertWidget.callback;
      insertWidget.callback = (value, ...args) => {
        previous?.call(insertWidget, value, ...args);
        if (!ready || !ALIASES.includes(value)) return;
        if (!isConnected(this, value)) {
          app.extensionManager?.toast?.add?.({
            severity: "warn", summary: "南风提示词", detail: `${value} 尚未连接素材`, life: 2500,
          });
          return;
        }
        insertAtCaret(promptWidget, value);
      };
      return result;
    };
  },
});

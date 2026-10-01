"use strict";
/* 临时探针（非交付件）：用一个极简 DOM 影子把 renderer/app-settings.js 的 relayProvCard
   真跑一遍，确认「API Key」那一行显示的是打码串（meta.keyMasked），而不是空白 / 明文。
   跑法：node test/_probe-relay-key-mask.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "renderer/app-settings.js"), "utf8");

/* 取 relayProvCard 函数体（与 smoke-relay-client.js 的 fnBody 同一口径） */
function fnBody(name) {
  const at = src.indexOf("function " + name + "(");
  const from = src.indexOf("{", at);
  let depth = 0;
  let i = from;
  let quote = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === "\\") i += 2;
      else if (c === quote) {
        quote = "";
        i++;
      } else i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      const j = src.indexOf("\n", i);
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const j = src.indexOf("*/", i);
      i = j < 0 ? src.length : j + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
    i++;
  }
  throw new Error("bad body");
}

const codes = [];
const all = [];
function mkEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    className: "",
    style: {},
    title: "",
    _text: "",
    type: "",
    disabled: false,
    checked: false,
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    querySelectorAll() {
      return [];
    },
    classList: { add() {}, remove() {}, contains() { return false; } },
    set textContent(v) {
      this._text = String(v);
    },
    get textContent() {
      return this._text;
    },
  };
  return el;
}
const document = {
  createElement: (tag) => {
    const el = mkEl(tag);
    all.push(el);
    if (tag === "code") codes.push(el);
    return el;
  },
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
};

const I18n = { t: (s) => s };
const MtRelay = {
  meta: (p) => p.relay || {},
  money: (y) => "¥" + Number(y || 0).toFixed(4),
  stateText: () => "上次同步 2026-09-30 22:50",
  maskKey: (s) => String(s).slice(0, 4) + "****" + String(s).slice(-4),
  KEY_PLACEHOLDER: "mtnode-account-token",
};
const S = {
  config: {
    providers: [
      {
        id: "mtnode-relay",
        source: "mtnode-relay",
        name: "MTNode 中转服务",
        baseUrl: "https://example.invalid/relay/v1",
        apiKey: "mtnode-account-token",
        models: ["deepseek-v4-flash"],
        relay: {
          at: Date.now(),
          models: ["deepseek-v4-flash"],
          kinds: { "deepseek-v4-flash": "text" },
          totalYuan: 0.3536,
          blocked: false,
          authKey: true,
          keyMasked: "a1b2****z9y8",
        },
      },
    ],
  },
};
const providerManuallyOff = () => false;
const settingsSaved = () => {};
const toast = () => {};
const closeProvCfgDlg = () => {};

const relayProvCard = new Function(
  "document",
  "I18n",
  "MtRelay",
  "S",
  "providerManuallyOff",
  "providerStateText",
  "settingsSaved",
  "toast",
  "closeProvCfgDlg",
  "return function relayProvCard(prov, i, onChange) " + fnBody("relayProvCard") + ";",
)(
  document,
  I18n,
  MtRelay,
  S,
  providerManuallyOff,
  () => "",
  settingsSaved,
  toast,
  closeProvCfgDlg,
);

const card = relayProvCard(S.config.providers[0], 0, () => {});
const texts = codes.map((c) => c.textContent);
console.log("只读 <code> 字段值：", JSON.stringify(texts, null, 0));
const keyEl = codes.find((c) => /^\S{4}\*{4}\S{4}$/.test(String(c.textContent)));
console.log("API Key 行 =", keyEl ? keyEl.textContent : "(未找到打码串)");
console.log(keyEl && keyEl.textContent === "a1b2****z9y8" ? "PASS" : "FAIL");

/* 未取到凭据时（authKey=false / keyMasked 空）：应退回占位串打码，不是空白 */
const prov2 = Object.assign({}, S.config.providers[0], {
  relay: Object.assign({}, S.config.providers[0].relay, { authKey: false, keyMasked: "" }),
});
codes.length = 0;
relayProvCard(prov2, 0, () => {});
const texts2 = codes.map((c) => c.textContent);
console.log("无凭据时只读字段：", JSON.stringify(texts2));
const masked2 = texts2.find((t) => /\*{4}/.test(String(t)));
console.log(masked2 === "mtno****oken" ? "PASS（退回占位串打码）" : "FAIL（" + masked2 + "）");

/* 凭据解不开（readIssue=decrypt_failed）：提示要说「重新登录一次」而不是笼统未取到 */
all.length = 0;
codes.length = 0;
const prov3 = Object.assign({}, S.config.providers[0], {
  relay: Object.assign({}, S.config.providers[0].relay, {
    authKey: false,
    keyMasked: "",
    keyIssue: "decrypt_failed",
  }),
});
relayProvCard(prov3, 0, () => {});
const hint3 = all.find((c) => /重新登录/.test(String(c.textContent)));
console.log("提示文案（凭据解不开）：", hint3 ? hint3.textContent : "(未找到)");
console.log(hint3 ? "PASS" : "FAIL");

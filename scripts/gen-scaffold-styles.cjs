/* ============ 一次性生成器：脚手架的风格文件（templates/app-scaffold/styles/*.css）====
 *
 * 为什么要有这个脚本：应用脚手架的样式要跟「新建应用默认欢迎页」的七套风格保持**同一个
 * 色相口径**。手抄七份必然漂移，所以这里把 templates/app-default/styles/<id>.css 的
 * 变量值当作真源，映射成脚手架自己的变量名后写出 —— 改了默认页的风格，跑一次这个脚本
 * 脚手架就跟着变。
 *
 * 这不是经常跑的构建步骤（默认页那份才是真源，脚手架是给开发者复制起手的示范），
 * 所以它是一次性生成器，产物入库、可直接阅读与微调。
 *
 * 用法：node scripts/gen-scaffold-styles.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "app-default", "styles");
const OUT = path.join(ROOT, "templates", "app-scaffold", "styles");
const IDS = ["minimal", "tech", "warm", "editorial", "terminal", "glass", "retro"];

/* 从默认页的风格文件里取 :root { … } 的变量表（一行一个 --k: v;） */
function varsOf(css) {
  const m = css.match(/:root\s*\{([\s\S]*?)\}/);
  const out = {};
  if (!m) return out;
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let hit;
  while ((hit = re.exec(m[1]))) out[hit[1].trim()] = hit[2].trim();
  return out;
}
/* 深色四套的强调色偏亮 → 主按钮上的字用深色；浅色三套强调色偏暗 → 用白字 */
const DARK_INK_STYLES = { minimal: 1, tech: 1, terminal: 1, glass: 1 };

function scaffoldVars(id, v) {
  const light = !DARK_INK_STYLES[id];
  const o = {
    "--bg": v["--bg"],
    "--bg-soft": v["--shell"],
    "--bg-sunken": v["--code-block"],
    "--line": v["--line"],
    "--line-2": v["--line2"],
    "--fg": v["--ink"],
    "--fg-dim": v["--ink2"],
    "--muted": v["--muted"],
    "--accent": v["--accent"],
    "--accent-hi": v["--accent-dim"],
    "--accent-ink": light ? "#ffffff" : "#100a16",
    "--sel": v["--sel"],
    "--sel-ink": v["--sel-ink"],
    "--radius": v["--radius"] && parseFloat(v["--radius"]) >= 8 ? "12px" : "4px",
    "--radius-sm": v["--radius"] && parseFloat(v["--radius"]) >= 8 ? "8px" : "4px",
    "--radius-xs": v["--radius"] && parseFloat(v["--radius"]) >= 8 ? "6px" : "3px",
    "--step-radius": v["--step-radius"],
    "--step-border": v["--step-border"] === "var(--accent-dim)" ? "var(--accent)" : v["--step-border"],
    "--step-ink": v["--step-ink"] === "var(--accent)" ? "var(--accent)" : v["--step-ink"],
  };
  if (v["--font-display"] && v["--font-display"].indexOf("var(--mono)") < 0)
    o["--font-display"] = v["--font-display"];
  if (v["--texture"] && v["--texture"] !== "none") {
    o["--texture"] = v["--texture"];
    o["--texture-op"] = v["--texture-op"] || "1";
  }
  return o;
}

const meta = {
  minimal: "极简（默认）",
  tech: "科技",
  warm: "暖读",
  editorial: "编辑",
  terminal: "终端",
  glass: "玻璃拟态",
  retro: "复古印刷",
};
/* 变量值里引用到的「默认页变量名」→ 脚手架变量名（两边语法一致，换了名字而已） */
const REF_MAP = {
  "--ink2": "--fg-dim",
  "--ink": "--fg",
  "--line2": "--line-2",
  "--line": "--line",
  "--muted": "--muted",
  "--accent-dim": "--accent-hi",
  "--accent": "--accent",
  "--bg": "--bg",
  "--shell": "--bg-soft",
  "--code-block": "--bg-sunken",
  "--mono": "--mono",
  "--sans": "--sans",
};
function translateRefs(v) {
  let s = String(v);
  for (const k of Object.keys(REF_MAP)) {
    s = s.split("var(" + k + ")").join("var(" + REF_MAP[k] + ")");
  }
  return s;
}
/* 每套风格额外的一两句形态覆盖（脚手架的结构钩子有限，只做确实看得出差别的几处） */
const extra = {
  tech: ".app-titles b,\n.data-v,\n.kv dd {\n  letter-spacing: 0.01em;\n}\n.intro-h {\n  font-family: var(--mono);\n  letter-spacing: -0.005em;\n}\n",
  terminal: ".app,\n.app-head,\n.intro,\n.data-row,\n.list-item {\n  font-family: var(--mono);\n}\n",
  editorial: ".app-head {\n  border-bottom: 3px double var(--line-2);\n}\n.intro-h {\n  letter-spacing: -0.03em;\n}\n",
  retro: ".app-head {\n  border-bottom: 2px solid var(--fg);\n}\n.intro-note {\n  border-top: 2px solid var(--fg);\n}\n",
  glass: ".app {\n  border-color: rgba(255, 255, 255, 0.16);\n  box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.08);\n}\n.app-head {\n  --shell-blur: blur(14px) saturate(140%);\n  background: rgba(20, 20, 32, 0.55);\n}\n",
  warm: ".intro-h {\n  letter-spacing: -0.012em;\n}\n",
};

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const id of IDS) {
  const src = fs.readFileSync(path.join(SRC, id + ".css"), "utf8");
  const vars = scaffoldVars(id, varsOf(src));
  const lines = [];
  lines.push("/* 风格 · " + meta[id] + "（应用脚手架） —— 由 scripts/gen-scaffold-styles.cjs 从");
  lines.push("   templates/app-default/styles/" + id + ".css 的变量表生成，改色请改那一份再跑一次。 */");
  lines.push(":root {");
  for (const k of Object.keys(vars)) {
    if (vars[k] == null || vars[k] === "") continue;
    lines.push("  " + k + ": " + translateRefs(vars[k]) + ";");
  }
  lines.push("}");
  if (extra[id]) lines.push("", extra[id].replace(/\n$/, ""));
  fs.writeFileSync(path.join(OUT, id + ".css"), lines.join("\n") + "\n", "utf8");
  n++;
}
console.log("[scaffold-styles] wrote " + n + " style files → " + path.relative(ROOT, OUT));
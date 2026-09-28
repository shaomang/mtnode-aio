/* test/smoke-topbar-buttons.js — 顶栏入口按钮「大小统一 + 图标」回归
 * ============================================================================
 * 运行：node test/smoke-topbar-buttons.js
 *
 * 需求：
 *   · 右上角「文档 / 讨论 / 审批」按钮大小与第二排图标按钮（.btn-ico）一致：
 *     36×32、14px 图标 + 9px 文字；此前走 .btn-stack 的 46px，同风格却宽 10px。
 *   · 画布 / 会话 / 团队 三个视图按钮各加一个线性图标，但**不改按钮大小**
 *     （高度仍 32px、padding 仍 0 10px，图标 14px 窄于两字标题所以宽度不变）；
 *     后续再把这三颗「主按钮」的字号 12px → 11px 略收，同样不动外框尺寸
 *     —— 掉下来的 2px（两字 × 1px）由 .tb-view-txt 的 padding:0 1px 补回。
 *
 * 另钉一条易踩的坑：I18n.applyDom 对 [data-i18n] 是 el.textContent = t(key)，
 * 所以视图按钮的文案必须留在 span[data-i18n] 上，button 自身不得再挂 data-i18n
 * ——否则切一次语言就把刚加的图标抹掉。
 * 只读断言：不改任何文件。
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "renderer", "css", "layout.css"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

/* 取某个按钮的开标签与内文（到 </button> 为止） */
const btnOf = (id) => {
  const at = HTML.indexOf('id="' + id + '"');
  if (at < 0) return "";
  const start = HTML.lastIndexOf("<button", at);
  const end = HTML.indexOf("</button>", at);
  return start >= 0 && end > start ? HTML.slice(start, end + 9) : "";
};
/* 取一段 CSS 规则体（直到下一个 "}"） */
const ruleOf = (selector) => {
  const at = CSS.indexOf(selector);
  if (at < 0) return "";
  const end = CSS.indexOf("}", at);
  return end > at ? CSS.slice(at, end + 1) : "";
};

console.log("[1] 右上角 文档 / 讨论 / 审批：尺寸统一到第二排图标按钮（36×32）");
{
  const docs = btnOf("btnDocs");
  const forum = btnOf("btnForum");
  const appr = btnOf("btnApprovals");
  ok(
    !!docs && !!forum && !!appr &&
      docs.indexOf('class="btn-stack-ico"') >= 0 &&
      forum.indexOf('class="btn-stack-ico"') >= 0 &&
      appr.indexOf('class="btn-stack-ico"') >= 0,
    "三个按钮都带 .btn-stack-ico 线性图标",
  );
  const rule = ruleOf(".topbar .btn-docs,");
  ok(
    /\.topbar\s+\.btn-docs\s*,\s*\.topbar\s+\.btn-forum\s*,\s*\.topbar\s+\.btn-approvals\s*,\s*\.topbar\s+\.btn-apps\s*\{/.test(rule),
    "layout.css 有一条同时命中这四个按钮的尺寸规则",
  );
  ok(/min-width:\s*36px/.test(rule), "尺寸规则与第二排 .btn-ico 同口径：min-width:36px");
  ok(/padding:\s*2px\s+4px\s+1px/.test(rule), "尺寸规则与第二排 .btn-ico 同口径：padding:2px 4px 1px");
  ok(
    /\.topbar\s+\.btn-docs\s+\.btn-stack-ico[\s\S]{0,160}?width:\s*14px[\s\S]{0,40}?height:\s*14px/.test(CSS),
    "三个按钮的图标 14px（与第二排 .btn-ico svg 一致）",
  );
  /* 第二排的参照口径必须还在，否则「统一」的后半句失去意义 */
  const icoRule = ruleOf(".topbar .btn-ico {");
  ok(
    /min-width:\s*36px/.test(icoRule) && /min-height:\s*32px/.test(icoRule),
    "第二排 .btn-ico 仍是 36×32 的参照口径（min-width:36px / min-height:32px）",
  );
}

console.log("\n[2] 画布 / 会话 / 团队：各加图标，且不改按钮大小");
{
  const views = { btnToolWf: "画布", btnToolAgent: "会话", btnTeam: "专家团" };
  Object.keys(views).forEach((id) => {
    const html = btnOf(id);
    ok(html.indexOf('class="tb-view-ico"') >= 0, "#" + id + "（" + views[id] + "）带 .tb-view-ico 图标");
    ok(
      html.indexOf('<span class="tb-view-txt" data-i18n="' + views[id] + '">') >= 0,
      "#" + id + " 文案留在 span.tb-view-txt[data-i18n] 上",
    );
    ok(
      !/<button[^>]*\bdata-i18n="/.test(html),
      "#" + id + " 的 button 自身不挂 data-i18n（否则切语言会抹掉图标）",
    );
  });
  ok(
    /el\.textContent\s*=\s*t\(key\)/.test(I18N),
    "i18n.js 的 [data-i18n] 仍走 textContent（本坑的前提成立，断言才有意义）",
  );
  const rule = ruleOf(".topbar .tb-view {");
  ok(/height:\s*32px/.test(rule), "画布 / 会话 / 团队 外框高度仍是 32px（未改大小）");
  ok(/padding:\s*0\s+10px/.test(rule), "画布 / 会话 / 团队 内边距仍是 0 10px（宽度不变）");
  ok(/flex-direction:\s*column/.test(rule), "改为图标在上、文字在下（与顶栏其它入口同风格）");
  ok(
    /\.topbar\s+\.tb-view\s+svg\s*\{[\s\S]{0,120}?width:\s*14px[\s\S]{0,40}?height:\s*14px/.test(CSS),
    "视图按钮图标 14px（窄于两字标题 → 不撑宽按钮）",
  );
  ok(/font-size:\s*11px/.test(rule), "画布 / 会话 / 团队 字号收到 11px（略减小，未动按钮大小）");
  ok(!/font-size:\s*12px/.test(rule), "不再残留 12px 的旧字号");
  const txtRule = ruleOf(".topbar .tb-view .tb-view-txt {");
  ok(
    /padding:\s*0\s+1px/.test(txtRule),
    "文案左右各补 1px 内边距，抵消 11px 少掉的 2px → 外框宽度不变",
  );
}

console.log("\n[3] 词条：三个视图按钮文案都有英文译文");
{
  ["画布", "会话", "专家团"].forEach((k) => {
    ok(new RegExp('"' + k + '":\\s*"[A-Za-z]').test(I18N), "「" + k + "」有英文译文");
  });
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-topbar-buttons)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-topbar-buttons)\n",
);
process.exit(fails ? 1 : 0);

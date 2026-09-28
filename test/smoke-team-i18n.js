"use strict";
/* 一人公司 / 专家团 —— i18n 词条与手册条目 —— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-team-i18n.js
 * 需求：团队四个渲染层脚本（app-team.js / app-teamview.js / app-team-recruit.js /
 *       app-team-icons.js）里所有经 T() / teamViewT() 下发的文案、图标标签与分组名、
 *       内置模板名与岗位，在英文界面都必须有译文（不得回落中文）；
 *       应用内手册补「一人公司」页条目（中英两版），打包白名单不含新主进程模块。
 * 覆盖：
 *   [1] 词条覆盖率：四个脚本的 T()/teamViewT() 字面量在 EN 词表里逐条命中
 *   [2] 图标目录：56 个图标标签 + 7 个分组名全部有英文译文
 *   [3] 模板名 / 岗位：39 个内置模板的名称与岗位全部有英文译文
 *   [4] 关键 UI 词条：招聘 / 圆桌 / 采纳 / 权限 / 画布锚点 / 分类管理 / 模型控制区 / 专家卡
 *   [5] 手册页：guides/manual/one-person-company.md + en 版，index.json 挂载（AI团队）
 *   [6] 打包白名单：renderer/** 已覆盖，无需改 build.json（无新主进程模块）
 */
const fs = require("fs");
const path = require("path");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

const I18n = require("../renderer/i18n.js");
/* app-team-icons.js 的 T() 读 window.I18n —— 给它一个 window 才能加载。 */
global.window = global.window || global;
require("../renderer/app-team-icons.js");
const ICONS = global.window.MTNodeTeamIcons;

const TEAM_FILES = [
  "renderer/app-team.js",
  "renderer/app-teamview.js",
  "renderer/app-team-recruit.js",
  "renderer/app-team-icons.js",
];

/* 抠出所有 T("…") / teamViewT("…") 的单行字面量（与 i18n 词表键一一对应）。 */
function teamKeys() {
  const set = new Set();
  const re = /\b(?:T|teamViewT)\(\s*(["'])((?:[^"'\\\n]|\\.)*?)\1\s*\)/g;
  for (const f of TEAM_FILES) {
    const src = read(f);
    let m;
    while ((m = re.exec(src))) set.add(m[2]);
  }
  return [...set].sort();
}

/* ===================== [1] 词条覆盖率 ===================== */
console.log("\n[1] 词条覆盖率：四个脚本的 T()/teamViewT() 文案全部有英文译文");
const KEYS = teamKeys();
ok(KEYS.length >= 200, "抠到 " + KEYS.length + " 条团队文案（≥200）");

const missing = [];
I18n.setLocale("en");
for (const k of KEYS) {
  const v = I18n.t(k);
  if (v === k || !/[A-Za-z]{2,}/.test(v)) missing.push(k);
}
ok(
  missing.length === 0,
  "英文界面无回落中文" +
    (missing.length
      ? "（缺 " + missing.length + " 条：" + missing.slice(0, 5).join(" / ") + "…）"
      : ""),
);

/* 中文界面必须原样显示（词表只做 zh → en 单向映射，不许把中文键也改掉）。 */
I18n.setLocale("zh");
let zhBroken = 0;
for (const k of KEYS) if (I18n.t(k) !== k) zhBroken++;
ok(zhBroken === 0, "中文界面原样显示全部 " + KEYS.length + " 条");
I18n.setLocale("zh");

/* ===================== [1b] 顶栏按钮与团队面板（index.html） ===================== */
console.log("\n[1b] 顶栏按钮与团队面板（renderer/index.html）文案有英文译文");
{
  const html = read("renderer/index.html");
  const btnAt = html.indexOf('id="btnTeam"');
  const btnEnd = btnAt >= 0 ? html.indexOf("</button>", btnAt) : -1;
  const paneAt = html.indexOf('id="teamPane"');
  const paneEnd = html.indexOf('class="assist-pane"');
  const region =
    btnAt >= 0 && btnEnd > btnAt && paneAt > btnEnd && paneEnd > paneAt
      ? html.slice(btnAt, btnEnd) + "\n" + html.slice(paneAt, paneEnd)
      : "";
  ok(region.length > 0, "定位到顶栏按钮 + 团队面板区段");
  const keys = new Set();
  const re = /data-i18n(?:-title|-placeholder)?="([^"]+)"/g;
  let m;
  while ((m = re.exec(region))) keys.add(m[1]);
  /* 顶部「＋ 新会话」按钮已移除（新建单聊改到左栏角色行的「＋」，文案由 JS 下发），
     面板里的 data-i18n 文案从 11 条降到 9 条。 */
  ok(keys.size >= 9, "抠到 " + keys.size + " 条界面文案");
  const miss = [];
  I18n.setLocale("en");
  for (const k of keys) {
    const v = I18n.t(k);
    if (v === k || !/[A-Za-z]{2,}/.test(v)) miss.push(k);
  }
  ok(miss.length === 0, "英文界面无回落中文" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
  I18n.setLocale("zh");
}

/* ===================== [2] 图标目录 ===================== */
console.log("\n[2] 图标目录：标签 + 分组名全部有英文译文");
ok(!!ICONS && typeof ICONS.keys === "function", "加载 app-team-icons.js（window.MTNodeTeamIcons）");
const ICON_KEYS = ICONS.keys();
ok(ICON_KEYS.length >= 48, "图标目录 " + ICON_KEYS.length + " 个（≥48 个空心线条 SVG）");
I18n.setLocale("en");
const iconMiss = ICON_KEYS.filter((k) => !/[A-Za-z]{2,}/.test(ICONS.label(k)));
ok(
  iconMiss.length === 0,
  "图标标签英文界面无回落中文" + (iconMiss.length ? "（缺：" + iconMiss.join(" / ") + "）" : ""),
);
const grpMiss = ICONS.groups().filter((g) => !/[A-Za-z]{2,}/.test(g.label));
ok(
  grpMiss.length === 0,
  "图标分组名英文界面无回落中文" + (grpMiss.length ? "（缺：" + grpMiss.map((g) => g.id).join(" / ") + "）" : ""),
);
ok(
  ICON_KEYS.every((k) => /fill="none"/.test(ICONS.svg(k)) && /stroke="currentColor"/.test(ICONS.svg(k))),
  "每个图标都是空心线条（fill:none + stroke:currentColor）",
);
I18n.setLocale("zh");

/* ===================== [3] 模板名 / 岗位 ===================== */
console.log("\n[3] 内置模板名与岗位全部有英文译文");
{
  const src = read("renderer/app-team-recruit.js");
  const seg = src.slice(src.indexOf("var PRESET_SPECS"), src.indexOf("function buildPresets"));
  const names = [];
  const roles = [];
  let m;
  const rn = /\bname:\s*"([^"]+)"/g;
  while ((m = rn.exec(seg))) names.push(m[1]);
  const rr = /\brole:\s*"([^"]+)"/g;
  while ((m = rr.exec(seg))) roles.push(m[1]);
  ok(names.length === 39, "抠到 39 个模板名（" + names.length + "）");
  ok(roles.length === 39, "抠到 39 个岗位名（" + roles.length + "）");
  I18n.setLocale("en");
  const nm = names.filter((k) => {
    const v = I18n.t(k);
    return v === k || !/[A-Za-z]{2,}/.test(v);
  });
  const rm = [...new Set(roles)].filter((k) => {
    const v = I18n.t(k);
    return v === k || !/[A-Za-z]{2,}/.test(v);
  });
  ok(nm.length === 0, "模板名无回落中文" + (nm.length ? "（缺：" + nm.join(" / ") + "）" : ""));
  ok(rm.length === 0, "岗位名无回落中文" + (rm.length ? "（缺：" + rm.join(" / ") + "）" : ""));
  I18n.setLocale("zh");
}

/* ===================== [4] 关键 UI 词条 ===================== */
console.log("\n[4] 关键 UI 词条：招聘 / 圆桌 / 采纳 / 权限 / 画布锚点 / 分类 / 模型 / 专家卡 / 编辑");
const KEY_TERMS = [
  "招募专家",
  "手动招聘",
  "自动招聘",
  "开始招聘",
  "确认录用",
  "圆桌讨论",
  "收敛出建议",
  "采纳并生成待办",
  "采纳为决策记录",
  "仅存档",
  "审批档",
  "长度预算",
  "少数意见（原文保留）",
  "未收敛分歧",
  "待验证假设",
  /* 画布锚点 / 图标选择器 / 分类管理 */
  "【画布】",
  "选择图标",
  "按语义分组的图标网格",
  "分类管理",
  "管理分类",
  "已有同名分类",
  "新的分类名称（≤12 字）",
  "画布没有可用工作区，无法采纳",
  /* 本轮新增：AI团队改名 / 锚点移除 / 模型控制区 / 结构化专家卡 */
  "AI团队",
  "AI团队：按画布管理专家，与专家对话（专家团）",
  "移除团队",
  "移除该画布的团队（专家与会话一并删除）",
  "移除画布「",
  "」的团队？该画布下的专家与会话将一并删除。",
  "温度",
  "专家卡",
  "实时预览 · 专家卡",
  "专家卡渲染失败。",
  "（未填岗位）",
  "基本信息",
  "人设",
  "简介",
  "背景",
  "专长",
  "风格",
  "提示词",
  "身份",
  "约束",
  "图标",
  /* 本轮新增：标题=当前画布 / 增量复制到其他画布 */
  "团队：按画布管理专家，与专家对话（专家团）",
  "当前画布：",
  "复制团队到其他画布",
  "把当前画布的团队（专家、会话、招聘草稿）复制到另一张画布。仅增量复制：只追加，不删除、不覆盖目标画布已有内容；当前画布不受影响。",
  "目标画布",
  "正在读取画布列表…",
  "没有其他画布可复制。先新建一张画布再来。",
  "当前画布还没有可复制的团队内容",
  "已复制到「",
  " 位、会话 ",
  " 个会话",
  /* 本轮新增：切画布时的团队加载屏（防串线） */
  "正在切换画布…",
  /* 本轮新增：左栏事实库分组（库行打开文件夹 / 新建文档，文档行只显示更新时间） */
  "打开所在文件夹",
  "新建文档",
  "例如：产品规格",
  "已新建文档「{name}」",
  "未建库",
  "{n} 篇",
  "读取中…",
  "刚刚",
  " 分钟前",
  " 小时前",
  "由专家建档或手动新建",
  /* 本轮新增：专家卡可直接编辑设定与权限（复用招聘对话框编辑模式） */
  "✎ 可编辑设定与权限",
  "✎ 编辑",
  "编辑该专家的设定与权限",
  "编辑入口未就绪",
  "编辑专家",
  "保存修改",
  "已保存专家设定",
  "校验未通过，未保存修改",
];
I18n.setLocale("en");
for (const k of KEY_TERMS) {
  const v = I18n.t(k);
  ok(v !== k && /[A-Za-z]{2,}/.test(v), "「" + k + "」→「" + v + "」");
}
I18n.setLocale("zh");

/* ===================== [5] 手册页 ===================== */
console.log("\n[5] 应用内手册：AI团队页（中英）+ index.json 挂载");
const ZH_DOC = "guides/manual/one-person-company.md";
const EN_DOC = "guides/manual/en/one-person-company.md";
ok(fs.existsSync(path.join(ROOT, ZH_DOC)), "存在中文手册页 " + ZH_DOC);
ok(fs.existsSync(path.join(ROOT, EN_DOC)), "存在英文手册页 " + EN_DOC);
const zhDoc = read(ZH_DOC);
const enDoc = read(EN_DOC);
ok(zhDoc.indexOf("招聘") >= 0 && zhDoc.indexOf("圆桌") >= 0, "中文页覆盖招聘与圆桌");
ok(/Hire|Recruit/i.test(enDoc) && /Roundtable/i.test(enDoc), "英文页覆盖招聘与圆桌");
ok(zhDoc.indexOf("画布锚点") >= 0 && zhDoc.indexOf("空心线条") >= 0, "中文页覆盖画布锚点与空心线条图标");
ok(zhDoc.indexOf("管理分类") >= 0 && zhDoc.indexOf("39 个") >= 0, "中文页覆盖分类管理与 39 个模板");
ok(/canvas anchor/i.test(enDoc) && /hollow-line/i.test(enDoc), "英文页覆盖 canvas anchor 与 hollow-line icons");
ok(/Manage categories/i.test(enDoc) && /39/.test(enDoc), "英文页覆盖分类管理与 39 个模板");
/* 口径：功能名 AI 团队、团队恒绑当前画布 / 增量复制 / 画布删除自动清理、温度、删除长度预算；
   本轮新增圆桌「按问题选人（不全员）→ 并行独立作答 → 主持人汇总」。 */
ok(zhDoc.indexOf("AI 团队") >= 0, "中文页功能名改为 AI 团队");
ok(zhDoc.indexOf("自动清理") >= 0, "中文页说明画布删除自动清理");
ok(zhDoc.indexOf("增量复制") >= 0 && zhDoc.indexOf("不删除、不覆盖") >= 0, "中文页说明「增量复制 / 不删除、不覆盖」");
ok(zhDoc.indexOf("当前画布名") >= 0, "中文页说明标题 = 当前画布名");
ok(zhDoc.indexOf("温度") >= 0, "中文页覆盖温度");
ok(zhDoc.indexOf("并行") >= 0 && zhDoc.indexOf("不全员") >= 0, "中文页覆盖圆桌选人（不全员）+ 并行作答");
ok(zhDoc.indexOf("专家卡") >= 0, "中文页覆盖专家卡");
ok(zhDoc.indexOf("长度预算") < 0, "中文页已删除「长度预算」描述");
ok(/AI team/i.test(enDoc), "英文页功能名改为 AI team");
ok(
  /pick participants by question/i.test(enDoc) && /in parallel/i.test(enDoc),
  "英文页覆盖圆桌选人（not the whole roster）+ 并行作答",
);
ok(/incrementally copies/i.test(enDoc) && /cleaned up automatically/i.test(enDoc), "英文页说明增量复制 / 画布删除自动清理");
ok(/current canvas name/i.test(enDoc), "英文页说明标题 = current canvas name");
ok(/temperature/i.test(enDoc) && /(read-only )?expert card/i.test(enDoc), "英文页覆盖温度与专家卡（可编辑口径）");
ok(!/length budget/i.test(enDoc), "英文页已删除 length budget 描述");
const idx = JSON.parse(read("guides/manual/index.json"));
const flat = [];
for (const s of idx.sections || [])
  for (const p of s.pages || []) flat.push(p);
const page = flat.find((p) => p && p.id === "one-person-company");
ok(!!page, "index.json 挂载 id = one-person-company");
if (page) {
  ok(page.title && page.title.zh && page.title.en, "目录标题中英双语齐全");
  ok(
    page.title.zh === "AI 团队与多角色" && page.title.en === "AI team & roles",
    "目录标题同步为 AI 团队与多角色 / AI team & roles",
  );
}

/* ===================== [6] 打包白名单 ===================== */
console.log("\n[6] 打包白名单：renderer/** 已覆盖（无新主进程模块）");
/* build.json 是 JSONC（带注释），不做 JSON.parse，按文本核对白名单。 */
const build = read("build.json");
ok(
  /"renderer\/\*\*"/.test(build),
  "build.json files 含 renderer/**（四个团队脚本随渲染层打包）",
);
for (const mod of ["app-team.js", "app-teamview.js", "app-team-recruit.js", "app-team-icons.js"]) {
  ok(fs.existsSync(path.join(ROOT, "renderer", mod)), "renderer/" + mod + " 存在");
}
ok(
  !fs.existsSync(path.join(ROOT, "team-store.js")) &&
    !fs.existsSync(path.join(ROOT, "consultation-engine.js")),
  "未新增根目录主进程模块（无需扩 build.json files 白名单）",
);

/* index.html 脚本加载顺序 = 模块分层：icons → team → recruit → teamview。 */
const html = read("renderer/index.html");
const order = ["app-team-icons.js", "app-team.js", "app-team-recruit.js", "app-teamview.js"].map(
  (m) => html.indexOf('src="' + m + '"'),
);
ok(
  order.every((i) => i >= 0) && order.every((i, n) => n === 0 || i > order[n - 1]),
  "index.html 脚本顺序：icons → team → recruit → teamview",
);

console.log(
  "\n" +
    (fails
      ? "FAILED " + fails + " / " + checks + " checks"
      : "ALL OK  " + checks + " checks"),
);
process.exit(fails ? 1 : 0);

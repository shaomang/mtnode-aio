"use strict";
/* 真机自验技能 · 冒烟测试（纯 Node，无 Electron / 不碰真实 %APPDATA%）
 *   node test/smoke-agent-skills-verify.js
 *
 * 被测对象是「开发 MTNode 自身功能时怎么自验」这条纪律的落地件：
 *   mtnode-agent-skills/mtnode/verify-in-app/SKILL.md   新技能（纯内部纪律技能）
 *   mtnode-agent-skills/plugins/plugin-dev/SKILL.md     交付清单指向它
 *   mtnode-agent-skills/app/app-dev/SKILL.md            验收清单指向它
 *   mtnode-agent-skills/mtnode/mcp-server/SKILL.md      自家开发会话怎么用 MCP 自验
 *   tools/mtnode-gui.mjs                                驱动脚本头注释指向它（逻辑未改）
 *
 * 覆盖：
 *   [1] 技能存在 + frontmatter：name / title / description 含 Use when ·
 *       **不写 menu: user**（内部纪律技能，不进用户技能清单）
 *   [2] 四条判据与纪律写全：独立实例（MTNODE_DATA_DIR · 开发态 npm start · 跑完关掉）·
 *       MCP 握手（discover / tools-list）· mtnode_gui 真读真点 · screenshot 读像素 ·
 *       证据落点（shots / report.json）·「未验证 + 原因」· 两层验证里 smoke 不替代真机 ·
 *       够不着的如实列出 · 真源指向 dsh/gateway 与 mtnode-mcp-server
 *   [3] 三条既有技能各有一处指向新技能
 *   [4] tools/mtnode-gui.mjs 只在头注释里指向它（不改逻辑）
 *   [5] 内置索引同步：index.json / INDEX.md 收录它、条目无 menu: user，
 *       且与技能树重算结果一致（忘跑 npm run build:agent-skills-index 就会红）
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REL = "mtnode-agent-skills/mtnode/verify-in-app/SKILL.md";
const NAME = "mtnode-verify-in-app";

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("  FAIL  " + msg);
  }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}
function ex(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}
function has(text, needle, msg) {
  const hit = String(text).indexOf(needle) >= 0;
  ok(hit, hit ? msg : msg + "（找不到：" + needle + "）");
}

try {
  /* ── [1] 技能存在 + frontmatter ── */
  console.log("\n[1] 技能 mtnode-verify-in-app：存在与 frontmatter");
  ok(ex(REL), "技能文件在 " + REL);
  const SK = read(REL);
  ok(/^---\s*\n[\s\S]*?\n---\s*\n/.test(SK), "SKILL.md 有 frontmatter");
  ok(/^---\s*\n[\s\S]*?\bname:\s*mtnode-verify-in-app\s*$/m.test(SK), "frontmatter name: " + NAME);
  ok(/^---\s*\n[\s\S]*?\btitle:\s*\S+/m.test(SK), "frontmatter 有 title");
  const fm = SK.match(/^---\s*\n([\s\S]*?)\n---/);
  const fmText = fm ? fm[1] : "";
  ok(/^description:\s*\S+/m.test(fmText), "frontmatter 有 description");
  ok(/description:[\s\S]*?Use when/i.test(fmText), "description 含英文 Use when（模型按关键词命中）");
  ok(!/^\s*menu:\s*user\s*$/m.test(fmText), "不写 menu: user（纯内部纪律技能，不进用户技能清单）");
  ok(SK.indexOf("内部开发纪律") >= 0, "正文自报是仓库内部开发纪律");

  /* ── [2] 四条判据与纪律 ── */
  console.log("\n[2] 真机自验的四条判据与纪律");
  has(SK, "MTNODE_DATA_DIR", "起独立数据目录的实例（MTNODE_DATA_DIR）");
  has(SK, "npm start", "开发态起实例（npm start = electron .）");
  ok(/用户正在用的那只实例/.test(SK) && /不占默认数据目录/.test(SK), "铁律：不驱动用户正在用的实例、不占默认数据目录");
  ok(/跑完关掉|收尾连子进程一起关掉/.test(SK), "跑完关掉验证实例");
  has(SK, "tools/mtnode-gui.mjs", "驱动入口指向 tools/mtnode-gui.mjs");
  has(SK, "discover", "MCP 握手用 discover（tools/list）");
  has(SK, "mtnode_gui", "窗口动作走 mtnode_gui");
  has(SK, "screenshot", "截图动作 screenshot");
  ok(/读像素|读图能力/.test(SK), "截图后要读像素确认");
  has(SK, "shots", "证据目录里截图放 shots\\");
  has(SK, "report.json", "证据目录里有 report.json");
  has(SK, "未验证", "做不到要写「未验证 + 原因」");
  has(SK, "node test/run-all.mjs", "两层验证：smoke 仍要跑");
  ok(/smoke 不替代真机自验|不替代真机自验/.test(SK), "写明 smoke 不替代真机自验");
  has(SK, "够不着的", "如实列出够不着的（原生菜单 / 文件框 / 托盘 / 最小化截图）");
  has(SK, "dsh/gateway", "工具参数表真源指向 dsh/gateway/*-plugin.mjs");
  has(SK, "mtnode-mcp-server", "工具面口径指向技能 mtnode-mcp-server");

  /* ── [3] 三条既有技能接线 ── */
  console.log("\n[3] 既有技能指向新技能");
  const PLUG = "mtnode-agent-skills/plugins/plugin-dev/SKILL.md";
  const APP = "mtnode-agent-skills/app/app-dev/SKILL.md";
  const MCP = "mtnode-agent-skills/mtnode/mcp-server/SKILL.md";
  has(read(PLUG), NAME, "plugin-dev 交付清单指向 " + NAME);
  has(read(PLUG), "真机点验", "plugin-dev 的「手工验证」已升级为真机点验");
  has(read(APP), NAME, "app-dev 验收清单指向 " + NAME);
  has(read(APP), "真机自验", "app-dev 有真机自验条目");
  has(read(MCP), "## 七、自家开发会话怎么用 MCP 自验", "mcp-server 补了「自家开发会话怎么用 MCP 自验」一节");
  has(read(MCP), NAME, "mcp-server 指向 " + NAME);
  has(read(MCP), "tools/mtnode-gui.mjs", "mcp-server 给出驱动命令");
  has(read(MCP), "## 八、自检与排障", "原「自检与排障」节顺延为八（编号未撞车）");

  /* ── [4] 驱动脚本：只在头注释指向它 ── */
  console.log("\n[4] tools/mtnode-gui.mjs 头注释指向新技能");
  const GUI = read("tools/mtnode-gui.mjs");
  ok(GUI.slice(0, 2000).indexOf(NAME) >= 0, "头注释里指向 " + NAME);
  ok(GUI.indexOf("verify-in-app/SKILL.md") >= 0, "头注释给出技能文件相对路径");
  ["discover", "call", "gui", "mtnode_gui", "MTNODE_GUI_ARGS"].forEach((k) =>
    has(GUI, k, "脚本原有能力仍在：" + k),
  );
  ok(GUI.indexOf("screenshot") >= 0 && GUI.indexOf("--data") >= 0, "脚本用法行未被改动（--data / screenshot 仍在头注释用法里）");

  /* ── [5] 内置索引同步 ── */
  console.log("\n[5] 内置索引收录且与技能树一致");
  const lib = require(path.join(ROOT, "mtnode-agent-skills-lib.js"));
  lib.CATEGORY_TITLES.app = "应用开发"; /* 与 tools/build-mtnode-agent-skill-index.js 同一口径 */
  const IDX_REL = "mtnode-agent-skills/index.json";
  let idx = null;
  try {
    idx = JSON.parse(read(IDX_REL));
  } catch (e) {}
  ok(!!idx, "index.json 可解析");
  const flat = JSON.stringify(idx || {});
  ok(flat.indexOf('"' + NAME + '"') > 0 && flat.indexOf("mtnode/verify-in-app/SKILL.md") > 0,
    "index.json 收录 " + NAME + " → mtnode/verify-in-app/SKILL.md");
  const entries = (lib.flattenIndex(idx || {}) || []).filter((s) => s.name === NAME);
  ok(entries.length === 1, "索引里恰好一条 " + NAME);
  ok(!!entries[0] && entries[0].menu === undefined, "索引条目没有 menu: user（内部纪律技能）");
  ok(!!entries[0] && entries[0].category === "mtnode", "归在 mtnode 类目下");
  has(read("mtnode-agent-skills/INDEX.md"), NAME, "INDEX.md 收录 " + NAME);
  has(read("mtnode-agent-skills/INDEX.md"), "`mtnode/verify-in-app/SKILL.md`", "INDEX.md 给出技能文件路径");

  /* 索引漂移闸：重算技能树，与落盘的 index.json / INDEX.md 对齐
     （改完技能忘了跑 npm run build:agent-skills-index 时，这里立刻红） */
  const treeRoot = path.join(ROOT, "mtnode-agent-skills");
  const fresh = lib.buildIndexFromTree(treeRoot);
  const strip = (o) => JSON.stringify({ ...o, updatedAt: 0 });
  ok(strip(fresh) === strip(idx), "落盘 index.json 与技能树重算结果一致（无索引漂移）");
  ok(lib.renderIndexMd(fresh) === read("mtnode-agent-skills/INDEX.md"), "落盘 INDEX.md 与技能树重算结果一致");
  const count = (lib.flattenIndex(fresh) || []).length;
  ok(count >= 16, "技能总数 " + count + " ≥ 16（新增一条）");

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  if (fails) process.exitCode = 1;
} catch (e) {
  console.log("FAIL  未捕获异常：" + ((e && e.stack) || e));
  process.exitCode = 1;
}

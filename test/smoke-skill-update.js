"use strict";
/* 工坊官方技能的更新链 —— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-skill-update.js
 * 病症：ext-repo/skills/<id>/SKILL.md 的正文改了（例如当年 minimax-music-prompt 重写成七层散文体那一版），
 *   但用户机上两份「旧正文」都不会自己变——
 *     ① 本机 dsh-home/skills/<id>/SKILL.md（助手 /技能 注入的就是它）；
 *     ② 线上目录 http://mt-agent.com/mtnode/ext/...（客户端能下拉到的只有它）。
 *   表现就是「提示词未正确更新」：仓库改了、助手还在用旧版。
 * 修复把更新链的四道口子都补上，本测试逐条钉住：
 *   [1] 目录侧：ext-repo/build.mjs 给每条技能带 version + sha256（正文指纹）
 *   [2] 宿主侧：dsh/main-dsh.js 的 skillList() 给每个已装技能算同一份 sha256
 *   [3] 客户端：设置·在线（app-settings.js）对「已安装」的技能给「更新」入口
 *             （必须 overwrite，否则 skillAdd 以「同名技能已存在」拒绝），并按 sha256 判「有更新」
 *   [4] 工坊：app-store.js「有更新」除 version 外还比 updatedAt（同版本号重新上架也能识别）
 *   [5] i18n：本轮新增词条中英齐备
 *   [6] 两侧指纹算法同源：抽出宿主 sha256Hex 真跑，与 node:crypto 同输入同结果
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

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
/* 源码统一按 \n 处理（仓库是 CRLF，切段与断言不必管行尾差异） */
const read = (rel) =>
  fs
    .readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");
const has = (src, needle, label) => ok(src.indexOf(needle) >= 0, label);
const I18N = require(path.join(ROOT, "renderer", "i18n.js"));

console.log("[1] 目录侧：build.mjs 每条技能带 version + sha256");
{
  const b = read("ext-repo/build.mjs");
  has(b, 'import crypto from "node:crypto"', "build.mjs 引 node:crypto");
  has(b, "function sha256Hex(buf)", "build.mjs 有 sha256Hex 指纹函数");
  has(
    b,
    'crypto.createHash("sha256").update(buf).digest("hex")',
    "指纹算法 = sha256 hex",
  );
  has(b, "version: meta.version", "目录条目带 version（frontmatter 有就抄）");
  has(b, "sha256: sha256Hex(Buffer.from(text, \"utf8\"))", "目录条目带 SKILL.md 正文指纹");
  has(
    read("ext-repo/README.md"),
    "只改正文也能被识别为有更新",
    "ext-repo/README 写明「只改正文也判有更新、记得 ext:sync」",
  );
}

console.log("[2] 宿主侧：skillList() 给每个已装技能同一份指纹");
{
  const d = read("dsh/main-dsh.js");
  has(d, "const crypto = require('crypto')", "main-dsh.js 引 crypto");
  has(d, "function sha256Hex(buf)", "main-dsh.js 有 sha256Hex（与目录同算法）");
  const list = d.slice(d.indexOf("skillList() {"), d.indexOf("skillGet(name) {"));
  has(list, "sha256 = sha256Hex(body)", "skillList 真算指纹（读的是 SKILL.md 字节）");
  has(list, "sha256,", "skillList 回执带 sha256 字段");
  ok(
    d.indexOf("sha256 = sha256Hex(body)") > 0 &&
      d.indexOf("'utf8'") > 0 &&
      list.indexOf("fs.readFileSync(skillMd)") >= 0,
    "指纹取自 SKILL.md 原文（不是标题/描述拼接）",
  );
}

console.log("[3] 客户端：设置·在线 给已装技能「更新」入口 + 按指纹判有更新");
{
  const s = read("renderer/app-settings.js");
  has(
    s,
    "const installSkillFromRepo = async (it, repo, opts)",
    "安装 / 更新共用一次下载落盘（不再各写一遍）",
  );
  has(s, "overwrite: !!opts.overwrite", "更新走 skillAdd overwrite（否则同名被拒）");
  has(s, "const skillHasUpdate = (it, rec)", "有专门的「该不该更新」判定函数");
  has(s, "String(it.sha256) !== String(rec.sha256)", "优先比正文指纹");
  has(s, "String(it.version) !== String(rec.version)", "没有指纹时退回版本号比较");
  has(s, 'tag.textContent = hasUpdate ? I18n.t("有更新") : I18n.t("已安装")', "卡片如实显示「有更新」");
  has(s, "installSkillFromRepo(it, repo, {\n                overwrite: true,\n              })", "更新按钮真的覆盖落盘");
  has(s, 'sha256: String(raw.sha256 || "")', "目录条目把 sha256 带进卡片数据");
  has(
    s,
    'I18n.t("将用线上目录版本覆盖本机技能「{name}」。确定更新？"',
    "覆盖前先确认（不静默改写用户机上的技能）",
  );
}

console.log("[4] 工坊：有更新 = version 变了 / 远端 updatedAt 更新");
{
  const st = read("renderer/app-store.js");
  const seg = st.slice(st.indexOf("const remoteAt = Number(item.updatedAt) || 0;"));
  const block = seg.slice(0, seg.indexOf("if (installed) {"));
  has(block, "remoteAt > localAt", "updatedAt 更新即算有更新（同版本号重新上架）");
  has(block, "String(local.version) !== String(item.version)", "version 比较保留");
  has(block, "Number(local && local.storeUpdatedAt) || 0", "本地侧取 .store-meta.json 的 updatedAt");
}

console.log("[5] i18n：新增词条中英齐备");
{
  const pairs = [
    "有更新",
    "已更新 ",
    "更新失败：",
    "线上目录已换新版，点此覆盖本机技能",
    "重新下载并覆盖本机技能",
    "将用线上目录版本覆盖本机技能「{name}」。确定更新？",
  ];
  for (const k of pairs) {
    I18N.setLocale("en");
    const en = I18N.t(k);
    I18N.setLocale("zh");
    ok(en !== k, "英文词条： " + k + " → " + en);
  }
}

console.log("[6] 两侧指纹算法同源（真跑宿主函数）");
{
  const d = read("dsh/main-dsh.js");
  const at = d.indexOf("function sha256Hex(buf) {");
  const from = d.slice(at, d.indexOf("\n}", at) + 2);
  const ctx = { crypto, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(from + "\nsha256Hex = sha256Hex;", ctx);
  const sample = Buffer.from("# 提示词\n七层散文体\n", "utf8");
  const mine = ctx.sha256Hex(sample);
  const ref = crypto.createHash("sha256").update(sample).digest("hex");
  ok(mine === ref, "宿主 sha256Hex == node:crypto sha256 hex");
  const trueSkill = fs.readFileSync(
    /* 取一份仍在工坊发版的技能正文当真实样本
       （minimax-music-* 已改为随包内置，见 mtnode-agent-skills/music/，不在这里） */
    path.join(ROOT, "ext-repo", "skills", "generate-workflow", "SKILL.md"),
  );
  ok(
    ctx.sha256Hex(trueSkill) ===
      crypto.createHash("sha256").update(trueSkill).digest("hex"),
    "对真实技能文件同样成立（目录 / 宿主同一份指纹）",
  );
}

console.log("");
console.log(fails ? "FAILED " + fails + "/" + checks : "ALL OK " + checks);
process.exit(fails ? 1 : 0);

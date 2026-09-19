"use strict";
/* MiniMax Music 提示词 / 歌词两份技能「完全内置」—— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-music-skills-builtin.js
 * 需求原话：这两份技能不再来自工坊，而是完全内置，并按官方
 *   https://www.minimax-music.com/blog/minimax-music-prompt-guide 重新设计；
 *   提示词产出形态固定为用户给的那段六句英文散文。
 * 本测试钉住六件事：
 *   [1] 内置库里有这两份技能，名字 = front matter name = 索引条目（同步不会装出错名目录）
 *   [2] frontmatter `menu: user` → 同步写 .builtin + .mtnode-builtin（用户清单与「/」菜单看得见、
 *       按「内置」保护）；其余内置技能仍写 .mtnode-internal（只给模型看）；工坊旧副本被同名接管
 *   [3] 工坊侧彻底没有它们：ext-repo/skills 目录、ext-repo/catalog.json 条目、seed 脚本会下架
 *   [4] 提示词技能的输出契约 = 一段六句散文（Style+Mood / Tempo&Groove / Instruments / Vocals /
 *       Structure / Production），含官方那段参考正文；禁标签堆、禁 JSON、禁把唱词写进 prompt
 *   [5] 歌词技能守「标签独占一行 + 不把舞台指示写进唱词」，并与提示词技能互指分工（不抄对方正文）
 *   [6] 宿主与界面口径：工坊下载不得覆盖内置名；指南 / 助手 / 媒体节点技能都按「内置」口径指向它们
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const lib = require(path.join(ROOT, "mtnode-agent-skills-lib.js"));

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
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8").replace(/\r\n?/g, "\n");

const NAMES = ["minimax-music-prompt", "minimax-music-lyrics"];
/* 用户指定的那段产出形态（官方 guide 参考正文），逐字钉住 */
const REFERENCE =
  "Modern dark R&B with subtle melodic trap influences and a late-night, introspective mood. " +
  "Slow to mid-tempo with a relaxed groove. " +
  "Deep 808 sub-bass, sparse piano chords, soft ambient synths, and restrained percussion. " +
  "Warm male baritone vocals with intimate sing-rap phrasing. " +
  "Keep the verses minimal, then open into a wider chorus with layered harmonies. " +
  "Clean modern mixing with clear vocals and controlled low end.";

console.log("[1] 内置库里有这两份技能（名字 = front matter name = 索引条目）");
const idx = JSON.parse(read("mtnode-agent-skills/index.json"));
const flat = (idx.categories || []).flatMap((c) =>
  (c.skills || []).map((s) => Object.assign({ categoryId: c.id, categoryTitle: c.title }, s)),
);
for (const nm of NAMES) {
  const ent = flat.find((s) => s.name === nm);
  ok(!!ent, "内置索引含 " + nm);
  if (!ent) continue;
  ok(ent.categoryId === "music", nm + " 归在 music 类目（不是工坊、不是 -install）");
  ok(ent.path === "music/" + nm + "/SKILL.md", nm + " 正文路径 = music/" + nm + "/SKILL.md");
  ok(ent.menu === "user", nm + " 索引条目带 menu: user（用户可见的内置技能）");
  const md = read("mtnode-agent-skills/" + ent.path);
  ok(
    ((md.match(/^name:[ \t]*(.+)$/m) || [])[1] || "").trim() === nm,
    nm + " 的 front matter name 与索引一致（同步按真名装目录）",
  );
  ok(/^menu:[ \t]*user[ \t]*$/m.test(md), nm + " front matter 写了 menu: user");
  ok(md.indexOf("内置") >= 0, nm + " 正文里讲明「随应用内置」（用户不必再去工坊找）");
}
ok(
  (idx.categories || []).some((c) => c.id === "music" && /MiniMax Music/.test(c.title)),
  "索引里 music 类目有中文标题（CATEGORY_TITLES 补了，不是裸 id）",
);
{
  const compact = lib.compactIndexText(idx);
  ok(compact.indexOf("【MTNode 内置技能索引】") === 0, "紧凑索引格式不变");
  for (const nm of NAMES) ok(compact.indexOf(nm) >= 0, "紧凑索引带 " + nm + "（每轮会话都知道能点名）");
  ok(compact.length <= 6000, "紧凑索引未撑爆预算（" + compact.length + " 字符）");
}

console.log("\n[2] 同步：menu: user 写 .builtin（可见·内置），其余仍写 .mtnode-internal（隐藏）");
{
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-music-skill-"));
  try {
    const r = lib.syncMtnodeAgentSkills(tmp, ROOT);
    ok(r.ok === true, "syncMtnodeAgentSkills 跑通（count=" + r.count + "）");
    const skillsRoot = path.join(tmp, "skills");
    const has = (name, mark) => fs.existsSync(path.join(skillsRoot, name, mark));
    for (const nm of NAMES) {
      ok(has(nm, "SKILL.md"), nm + " 正文落到 $DSH_HOME/skills/" + nm);
      ok(has(nm, ".builtin"), nm + " 带 .builtin → skillList 按「内置」列出（用户菜单里可见）");
      ok(has(nm, ".mtnode-builtin"), nm + " 带 .mtnode-builtin 出处标记（供同步回收）");
      ok(!has(nm, ".mtnode-internal"), nm + " 不带 .mtnode-internal（带了就从用户清单消失）");
    }
    ok(
      has("mtnode-canvas-edit-rules", ".mtnode-internal") &&
        !has("mtnode-canvas-edit-rules", ".builtin"),
      "产品纪律类内置技能仍是 .mtnode-internal（不进用户清单，行为不变）",
    );
    /* 用户机上工坊旧副本的同名接管 */
    const legacy = path.join(skillsRoot, "minimax-music-prompt");
    fs.writeFileSync(path.join(legacy, "SKILL.md"), "---\nname: minimax-music-prompt\n---\n\n旧工坊正文\n", "utf8");
    fs.writeFileSync(path.join(legacy, ".store-meta.json"), "{}\n", "utf8");
    fs.rmSync(path.join(legacy, ".builtin"));
    fs.rmSync(path.join(legacy, ".mtnode-builtin"));
    ok(lib.syncMtnodeAgentSkills(tmp, ROOT).ok === true, "二次同步跑通（幂等）");
    ok(
      !fs.existsSync(path.join(legacy, ".store-meta.json")),
      "旧工坊副本的 .store-meta.json 被收掉（不再按工坊技能判「有更新」）",
    );
    ok(
      /六句/.test(fs.readFileSync(path.join(legacy, "SKILL.md"), "utf8")),
      "旧副本正文换成内置版（同名接管，用户不必手动重装）",
    );
    ok(
      fs.existsSync(path.join(legacy, ".builtin")) &&
        fs.existsSync(path.join(legacy, ".mtnode-builtin")),
      "接管后 .builtin / .mtnode-builtin 标记补齐",
    );
    /* 回收口径：库里删条目 → 带出处标记的目录清掉；用户自建技能不动 */
    fs.rmSync(path.join(skillsRoot, "minimax-music-lyrics"), { recursive: true, force: true });
    fs.mkdirSync(path.join(skillsRoot, "my-own-skill"), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, "my-own-skill", "SKILL.md"), "# 我的技能\n", "utf8");
    ok(lib.syncMtnodeAgentSkills(tmp, ROOT).ok === true, "技能缺失时同步不炸");
    ok(
      fs.existsSync(path.join(skillsRoot, "minimax-music-lyrics", "SKILL.md")),
      "minimax-music-lyrics 由内置库装回（升级即自愈）",
    );
    ok(
      fs.existsSync(path.join(skillsRoot, "my-own-skill", "SKILL.md")),
      "用户自建技能目录不被内置同步回收",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n[3] 工坊侧彻底没有它们（不再来自工坊）");
for (const nm of NAMES) {
  ok(
    !fs.existsSync(path.join(ROOT, ...("ext-repo/skills/" + nm).split("/"))),
    "ext-repo/skills/" + nm + " 已删除（工坊源里不留副本）",
  );
  ok(!new RegExp('"id":\\s*"' + nm + '"').test(read("ext-repo/catalog.json")), nm + " 不在 ext-repo/catalog.json");
}
{
  const seed = read("store-saas/seed-skills.mjs");
  ok(seed.indexOf("RETIRED_SKILLS") > 0, "seed-skills.mjs 有 RETIRED_SKILLS 下架名单");
  for (const nm of NAMES)
    ok(seed.indexOf('"' + nm + '"') > 0, "RETIRED_SKILLS 里含 " + nm + "（下次播种从工坊库删掉）");
  ok(seed.indexOf("retired skill from store") > 0, "下架走与 -install 同一套 DELETE 路径");
}
{
  const r = read("mtnode-agent-skills/README.md");
  ok(r.indexOf("`music/`") >= 0, "技能库 README 记了 music/ 类目");
  ok(r.indexOf("menu: user") >= 0, "README 写明 menu: user 的两种标记口径");
  ok(read("AGENTS.md").indexOf("menu: user") >= 0, "AGENTS.md 目录约定记下方针");
}

console.log("\n[4] 提示词技能 = 按官方 guide 重设计，产出固定为一段六句散文");
{
  const md = read("mtnode-agent-skills/music/minimax-music-prompt/SKILL.md");
  ok(md.indexOf(REFERENCE) >= 0, "含用户指定的那段参考正文（逐字）");
  ok(/^##\s*输出格式/m.test(md), "有「输出格式」硬口径章节");
  for (const layer of [
    "Style + Mood",
    "Tempo & Groove",
    "Instruments",
    "Vocals",
    "Structure",
    "Production",
  ])
    ok(md.indexOf(layer) >= 0, "六句对应到官方分层：" + layer);
  ok(md.indexOf("minimax-music.com/blog/minimax-music-prompt-guide") >= 0, "依据链指向官方 prompt guide");
  ok(md.indexOf("六句") >= 0, "写死「一段六句」的形态");
  ok(md.indexOf("逗号标签") >= 0 && md.indexOf("不要") >= 0, "禁止逗号标签堆砌（官方：写句子不写标签）");
  ok(md.indexOf("JSON") >= 0, "禁止 JSON / 分节标题形态");
  ok(md.indexOf("45") >= 0 && md.indexOf("110") >= 0, "词数口径 45–110");
  ok(md.indexOf("2000") >= 0, "字符上限 2000（与节点侧 music_gen 输入一致）");
  ok(md.indexOf("minimax-music-lyrics") >= 0, "与歌词技能互指（两个输入的分工）");
  ok(md.indexOf("端口 0") >= 0, "写明 MTNode 口径：端口 0 = 风格提示词");
  ok(md.indexOf("Introduce → Build → Release → Contrast → Resolve") >= 0, "含官方情绪结构骨架");
  ok(md.indexOf("一个问题") >= 0 && md.indexOf("一次修改") >= 0, "含官方最小改动迭代口径");
  ok(md.indexOf("不编造") >= 0, "不编造 BPM / 调性 / 演唱者");
  ok(md.indexOf("校验清单") >= 0, "有交付前校验清单");
  ok(!/Structured Caption/.test(md), "不再保留三标题 Structured Caption 档（形态统一为六句散文）");
  ok(REFERENCE.match(/[^.]+\./g).length === 6, "参考正文正好 6 句（与「六句」口径自洽）");
}

console.log("\n[5] 歌词技能：结构标签与唱词纪律仍在，并与提示词分工互斥");
{
  const md = read("mtnode-agent-skills/music/minimax-music-lyrics/SKILL.md");
  ok(md.indexOf(REFERENCE) < 0, "歌词技能不抄提示词那段散文（不重复真源）");
  ok(md.indexOf("minimax-music-prompt") >= 0, "歌词技能指回提示词技能");
  for (const tag of ["[Intro]", "[Verse]", "[Pre-Chorus]", "[Chorus]", "[Bridge]", "[Outro]"])
    ok(md.indexOf(tag) >= 0, "结构标签含 " + tag);
  ok(md.indexOf("舞台指示") >= 0, "写明不要把舞台指示写进会唱出来的正文");
  ok(md.indexOf("独占一行") >= 0, "结构标签独占一行");
  ok(md.indexOf("3500") > 0, "写明 music_gen 歌词字符上限");
  ok(md.indexOf("端口 1") >= 0, "写明 MTNode 口径：端口 1 = 歌词");
  ok(md.indexOf("校验清单") >= 0, "有交付前校验清单");
}

console.log("\n[6] 宿主与界面口径：内置名不可被工坊覆盖，各处按「内置」指向");
{
  const d = read("dsh/main-dsh.js");
  ok(d.indexOf(".mtnode-builtin") >= 0, "main-dsh.js 认 .mtnode-builtin 出处标记");
  ok(
    /skillAdd\(\{[\s\S]{0,2600}?\.mtnode-internal[\s\S]{0,200}?\.mtnode-builtin/.test(d),
    "skillAdd 一并拒绝覆盖 .mtnode-internal / .mtnode-builtin（工坊旧目录抢不回同名）",
  );
  ok(
    /skillRemove\(name\)[\s\S]{0,900}?\.mtnode-internal[\s\S]{0,160}?\.mtnode-builtin/.test(d),
    "skillRemove 也拒绝卸载这两类内置标记（内置技能不会被误删）",
  );
  const zh = read("guides/nodes/music_gen.md");
  const en = read("guides/nodes/en/music_gen.md");
  ok(zh.indexOf("内置技能") >= 0 && zh.indexOf("不用再去创意工坊下载") >= 0, "中文节点指南写明内置、不必去工坊");
  ok(/built-in skills/i.test(en) && /no Creative Workshop download/i.test(en), "英文指南同口径");
  ok(zh.indexOf("六句") >= 0 && /six sentences/.test(en), "指南里给出六句散文形态");
  for (const f of ["guides/nodes/yue_gen.md", "guides/nodes/en/yue_gen.md"])
    ok(/内置技能|built-in skills/i.test(read(f)), f + " 同步口径（YuE2 也用这两份）");
  ok(read("guides/nodes/_write.mjs").indexOf("不用再去创意工坊下载") >= 0, "指南生成脚本里也是新口径（不会回退）");
  const assist = read("renderer/app-assist.js");
  ok(assist.indexOf("minimax-music-prompt") >= 0, "助手提示指向内置 minimax-music-prompt");
  ok(assist.indexOf('"minimax-music-prompt": ["prompt", "音乐生成"]') >= 0, "技能菜单归类表同名可用");
  ok(
    read("mtnode-agent-skills/mtnode/media-gen-nodes/SKILL.md").indexOf("menu: user") >= 0,
    "媒体节点技能把两段文本的写法指向这两份内置技能",
  );
}

console.log("");
console.log(fails ? "FAILED " + fails + "/" + checks : "ALL OK " + checks);
process.exit(fails ? 1 : 0);

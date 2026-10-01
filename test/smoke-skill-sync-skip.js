"use strict";
/* test/smoke-skill-sync-skip.js — 内置技能库同步「没变就不动」的回归口径
 *   node test/smoke-skill-sync-skip.js           断言模式（绿 = 退出码 0）
 *   node test/smoke-skill-sync-skip.js --report  附加实测耗时（诊断用）
 *
 * 为什么要有它（本轮用户报障：「会话 / 应用开发对话窗输入文字略显卡顿」）：
 *   渲染层输入框每敲一个字都要过一遍「/」技能候选，候选来自 IPC skill:list；
 *   而宿主侧 skillList() 每次调用都**无条件** rm -rf 内置库、重拷 1MB / 119 个文件、
 *   逐份读 SKILL.md 算 sha256、重写 index.json / INDEX.md，再按技能逐个删目录重拷。
 *   实测 106–140ms/次，全在主进程线程上；渲染层缓存只有 5 秒 —— 打字时就每 5 秒卡一下。
 *   修法 = 库根写一份同步标记（源树指纹 + 上次装出来的出处），指纹与目标盘都对得上就
 *   **一个文件都不碰**地直接返回上次的索引（见 mtnode-agent-skills-lib.js 的 SYNC_STATE_FILE 段）。
 *
 * 本测试钉住四件事（纯 Node、零依赖、只写临时目录）：
 *   [1] 首次同步仍是整树重建（标记不存在 → 必须真装一遍，不能凭空说「已就绪」）
 *   [2] 第二次同步一个文件都不碰（跳过口径生效；--report 另给实测耗时）
 *   [3] 源树没变但目标盘漂了（库被删 / 技能目录被删 / 标记文件被去掉 / 内置技能被下架残留）
 *       → 必须整树重建（升级自愈的口径不变，不能只信标记）
 *   [4] 用户自建技能目录既不参与跳过判定、也不被同步回收
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const lib = require(path.join(ROOT, "mtnode-agent-skills-lib.js"));

const REPORT = process.argv.indexOf("--report") >= 0;

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
const exists = (p) => fs.existsSync(p);

/* 「这一次调用真的重建了整树吗」的硬证据：同步函数用 rmDirSafe(dest) 起手，
   所以整树重建必然出现一次 rm -rf 库根 —— 计数器钉死这个行为，比掐秒稳。 */
function syncWithRebuildProbe(home, appRoot) {
  const dist = path.join(home, "mtnode-agent-skills");
  const orig = fs.rmSync;
  let rebuilt = 0;
  fs.rmSync = function (p, opts) {
    if (String(p) === dist) rebuilt++;
    return orig.call(fs, p, opts);
  };
  let res = null;
  let err = null;
  const t0 = process.hrtime.bigint();
  try {
    res = lib.syncMtnodeAgentSkills(home, appRoot);
  } catch (e) {
    err = e;
  } finally {
    fs.rmSync = orig;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (err) throw err;
  return { res, rebuilt, ms };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-skill-sync-"));
const home = path.join(tmp, "dsh-home");
const dist = path.join(home, "mtnode-agent-skills");
const skillsRoot = path.join(home, "skills");
const STATE = path.join(dist, ".mtnode-skills-sync.json");
const mk = (rel) => path.join(dist, ...rel.split("/"));
const mkskill = (name) => path.join(skillsRoot, name);

try {
  console.log("\n[1] 首次同步 = 真装一遍（不许凭标记跳过）");
  const first = syncWithRebuildProbe(home, ROOT);
  ok(first.res && first.res.ok === true, "首次同步 ok（count=" + (first.res && first.res.count) + "）");
  ok(first.rebuilt === 1, "首次同步真的整树重建（rm -rf 库根 1 次）");
  ok(!first.res.skipped, "首次同步不带 skipped 标记");
  ok(exists(STATE), "库根写出同步标记 .mtnode-skills-sync.json");
  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  ok(typeof state.fingerprint === "string" && state.fingerprint.length > 0, "标记里有源树指纹");
  ok(Array.isArray(state.skills) && state.skills.length === first.res.count, "标记里逐条记了装出来的技能");
  ok(
    state.skills.every((s) => s && s.name && s.path && typeof s.visible === "boolean"),
    "每条技能记了 name / path / visible（跳过校验要用它）",
  );

  console.log("\n[2] 第二次同步 = 一个文件都不碰");
  const second = syncWithRebuildProbe(home, ROOT);
  ok(second.res && second.res.ok === true, "第二次同步 ok");
  ok(second.res.skipped === true, "第二次同步走跳过快路径（skipped=true）");
  ok(second.rebuilt === 0, "第二次同步没有 rm -rf 库根（一个文件都没删）");
  ok(second.res.count === first.res.count, "跳过时返回的条数与整树重建一致");
  ok(
    typeof second.res.compact === "string" && second.res.compact.length > 0,
    "跳过时照旧带回 compact 索引文本（网关按需注入用）",
  );
  ok(
    second.res.index && second.res.index.format === first.res.index.format,
    "跳过时返回的是盘上那份索引（不是现编的）",
  );
  const third = syncWithRebuildProbe(home, ROOT);
  ok(third.res.skipped === true && third.rebuilt === 0, "第三次同步同样跳过（快路径稳定）");
  if (REPORT) {
    console.log(
      "  ..    实测：首次 " + first.ms.toFixed(1) + "ms · 跳过 " +
        second.ms.toFixed(1) + "ms / " + third.ms.toFixed(1) + "ms",
    );
  }

  console.log("\n[3] 源树没变但目标盘漂了 → 必须整树重建（不能只信标记）");
  const drop = (p) => fs.rmSync(p, { recursive: true, force: true });

  drop(dist);
  const lostLib = syncWithRebuildProbe(home, ROOT);
  ok(lostLib.rebuilt === 1 && !lostLib.res.skipped, "整个内置库被删 → 整树重建补回");

  drop(mkskill("mtnode-canvas-edit-rules"));
  const lostSkill = syncWithRebuildProbe(home, ROOT);
  ok(lostSkill.rebuilt === 1 && !lostSkill.res.skipped, "某颗内置技能目录被删 → 整树重建装回");

  drop(path.join(mkskill("minimax-music-prompt"), ".builtin"));
  const lostMark = syncWithRebuildProbe(home, ROOT);
  ok(lostMark.rebuilt === 1 && !lostMark.res.skipped, "menu: user 技能的 .builtin 被去掉 → 整树重建补齐");

  drop(path.join(mkskill("mtnode-dev-architect"), ".mtnode-internal"));
  const lostInner = syncWithRebuildProbe(home, ROOT);
  ok(lostInner.rebuilt === 1, "内部技能 .mtnode-internal 被去掉 → 整树重建补齐");

  drop(STATE);
  const lostState = syncWithRebuildProbe(home, ROOT);
  ok(lostState.rebuilt === 1 && !lostState.res.skipped, "同步标记自己丢了 → 整树重建一次");
  ok(
    (syncWithRebuildProbe(home, ROOT).res || {}).skipped === true,
    "重建后标记补齐 → 下一次又跳过",
  );

  /* 下架残留：库里已没有、但目标盘还留着一个带内置标记的目录 → 必须重建把它回收 */
  fs.mkdirSync(mkskill("mtnode-retired-thing"), { recursive: true });
  fs.writeFileSync(path.join(mkskill("mtnode-retired-thing"), "SKILL.md"), "# 已下线\n", "utf8");
  fs.writeFileSync(path.join(mkskill("mtnode-retired-thing"), ".mtnode-internal"), "1\n", "utf8");
  const retired = syncWithRebuildProbe(home, ROOT);
  ok(retired.rebuilt === 1 && !retired.res.skipped, "带内置标记的下架残留 → 整树重建");
  ok(!exists(mkskill("mtnode-retired-thing")), "下架残留被回收掉");

  console.log("\n[4] 用户自建技能：不参与跳过判定，也不被回收");
  fs.mkdirSync(mkskill("my-own-skill"), { recursive: true });
  fs.writeFileSync(path.join(mkskill("my-own-skill"), "SKILL.md"), "# 我的技能\n", "utf8");
  const withOwn = syncWithRebuildProbe(home, ROOT);
  ok(withOwn.res.skipped === true, "用户自建技能不影响跳过（每条调用不必重建）");
  ok(exists(path.join(mkskill("my-own-skill"), "SKILL.md")), "用户自建技能不被内置同步回收");

  console.log("\n[5] 契约：跳过标记的形态写死在代码里（改名 / 改语义即变红）");
  const src = read("mtnode-agent-skills-lib.js");
  ok(src.indexOf('SYNC_STATE_FILE = ".mtnode-skills-sync.json"') > 0, "标记文件名 = .mtnode-skills-sync.json");
  ok(/const SYNC_FORMAT = \d+;/.test(src), "带 SYNC_FORMAT 形态号（同步算法升级时手动 +1 即可强制重建）");
  ok(
    /function syncStateUsable\(/.test(src) && /function writeSyncState\(/.test(src),
    "同步标记的读写各是一个具名函数",
  );
  ok(
    /if \(prev && prev\.fingerprint === fingerprint && syncStateUsable\(/.test(src),
    "跳过判据 = 指纹一致 且 目标盘该有的都在",
  );
  /* 旧写法（无条件重建）的指纹：rmDirSafe(dest) 紧跟函数签名 —— 命中即说明退化回去了 */
  ok(
    !/function syncMtnodeAgentSkills\(dshHome, appRoot\) \{\s*const src[\s\S]{0,200}?rmDirSafe\(dest\);/.test(
      src,
    ),
    "syncMtnodeAgentSkills 不再无条件 rm -rf 库根",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL OK " + checks));
process.exit(fails ? 1 : 0);

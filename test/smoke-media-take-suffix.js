"use strict";
/* 冒烟：生成节点落盘撞名的 take 编号 —— 固定 #1、#2 … 且递增，绝不叠加后缀
 *   node test/smoke-media-take-suffix.js
 *
 * 需求口径：视频 / 音乐 / 语音 / 动效等生成节点的保存路径已有文件时，旧实现固定贴 _1
 *   （而且渲染层把改名后的路径写回 node.outputPath，于是同一路径跑三次叠成 foo_1_1_1）。
 *   现在统一：第几个 take 一律用 #N 标，号只增不减。
 *
 * 覆盖：
 *   [1] takeStemParts（renderer/app.js 真源函数）：#N 认号、_N / _0N 只当旧标记剥掉、年份不受影响
 *   [2] allocateUniqueMediaExport（真源函数 + 假 fileExists）：空 → 原名；撞名 → #1 → #2 → #3
 *   [3] 旧污染治愈 + 不叠加：foo_1.mp4 / foo#1.mp4 都接成 #2、#3，绝不出现 _1_1
 *   [4] 抽卡多次：mediaGenRollSuffix / resolveMediaGenRollExport 出 #1、#2（配置名带旧标记也不叠）
 *   [5] 四个宿主（h3 / music3 / yue / remotion）的 uniqueFileInDir 同口径（真源函数跑真跑）
 *   [6] 文案口径：i18n / 设置 tooltip / 指南 全说 #1、#2，不再有 _01、_02
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let checks = 0;
let fails = 0;
function ok(c, msg) {
  checks++;
  if (!c) {
    fails++;
    console.log("  FAIL  " + msg);
  } else console.log("  ok    " + msg);
}
function eq(a, b, msg) {
  ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
}
function has(s, n, msg) {
  ok(String(s).indexOf(n) >= 0, msg + (String(s).indexOf(n) >= 0 ? "" : "（缺 " + JSON.stringify(n) + "）"));
}
function hasnt(s, n, msg) {
  ok(String(s).indexOf(n) < 0, msg + (String(s).indexOf(n) < 0 ? "" : "（仍含 " + JSON.stringify(n) + "）"));
}
function section(t) {
  console.log("\n── " + t + " ──");
}

/* ---------- 从源码里按名字抠出顶层函数 ---------- */
function fnBody(src, name) {
  const m = src.match(
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
  );
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error("函数体不闭合：" + name);
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const APP = read("renderer/app.js");
const HOSTS = [
  "h3/main-h3.js",
  "music3/main-music3.js",
  "yue/main-yue.js",
  "remotion/main-remotion.js",
];

/* ---------- 渲染层沙箱：takeStemParts / allocateUniqueMediaExport 是源码真函数 ---------- */
const FILES = new Set();
let CURRENT_EXP = null;
const sandbox = {
  console, Math, JSON, String, Number, Boolean, RegExp, Object, Array,
  extOf: (n) => {
    const m = /(\.[a-z0-9]+)$/i.exec(String(n || ""));
    return m ? m[1] : "";
  },
  stemOfFilename: (n) =>
    String(n || "").replace(/\.(ya?ml|png|jpe?g|webp|gif|wav|flac|mp3|mp4|webm|mov|pdf)$/i, ""),
  joinPath: (d, f) => String(d || "").replace(/[\\/]+$/, "") + "/" + f,
  pathExistsAbs: async (p) => FILES.has(String(p)),
  resolveMediaGenExport: () => CURRENT_EXP,
  mediaGenExt: () => ".mp4",
};
vm.createContext(sandbox);
vm.runInContext(
  extract(APP, ["takeStemParts", "allocateUniqueMediaExport", "mediaGenRollSuffix", "resolveMediaGenRollExport"]),
  sandbox,
);
const G = (n) => vm.runInContext(n, sandbox);

const mkExp = (filename, dir) => ({
  ok: true,
  outputDir: dir || "D:/out",
  filename,
  path: (dir || "D:/out") + "/" + filename,
});
const alloc = (filename, dir) => sandbox.allocateUniqueMediaExport(mkExp(filename, dir));

(async () => {
  section("[1] takeStemParts：#N 认号 · _N / _0N 只当旧标记剥掉");
  const parts = G("takeStemParts");
  eq(JSON.stringify(parts("foo")), JSON.stringify({ base: "foo", from: 0 }), "无标记 → 原名 / from=0");
  eq(JSON.stringify(parts("foo#3")), JSON.stringify({ base: "foo", from: 3 }), "#3 → 认号 3（接着往下递增）");
  eq(JSON.stringify(parts("foo_1")), JSON.stringify({ base: "foo", from: 0 }), "旧式 _1 → 剥掉、不认号");
  eq(JSON.stringify(parts("foo_01")), JSON.stringify({ base: "foo", from: 0 }), "旧式 _01 → 剥掉");
  eq(JSON.stringify(parts("foo_1_1_1")), JSON.stringify({ base: "foo", from: 0 }), "旧实现叠出来的 _1_1_1 → 一次剥干净");
  eq(JSON.stringify(parts("报告_2024")), JSON.stringify({ base: "报告_2024", from: 0 }), "4 位年份（_2024）不当 take 标记");
  eq(JSON.stringify(parts("foo_310")), JSON.stringify({ base: "foo", from: 0 }), "3 位旧标记（_310）仍剥掉");

  section("[2] allocateUniqueMediaExport：撞名 → #1 → #2 → #3");
  FILES.clear();
  let r = await alloc("out.mp4");
  eq(r.filename, "out.mp4", "目标不存在 → 用配置名，不加任何后缀");
  ok(!r.renamed, "目标不存在 → renamed 不置位（不弹「改为保存为」）");

  FILES.clear();
  FILES.add("D:/out/out.mp4");
  r = await alloc("out.mp4");
  eq(r.filename, "out#1.mp4", "已有 out.mp4 → out#1.mp4（不再是 out_1.mp4）");
  ok(r.renamed === true, "撞名 → renamed=true（节点状态行会说明实际落点）");

  FILES.add("D:/out/out#1.mp4");
  r = await alloc("out.mp4");
  eq(r.filename, "out#2.mp4", "out.mp4 + out#1.mp4 都在 → out#2.mp4（递增）");

  FILES.add("D:/out/out#2.mp4");
  r = await alloc("out.mp4");
  eq(r.filename, "out#3.mp4", "三个都在 → out#3.mp4（继续递增）");

  section("[3] 不叠加后缀：上一轮写回的路径 / 旧实现污染的名字都能接着递增");
  FILES.clear();
  FILES.add("D:/out/out#1.mp4");
  r = await alloc("out#1.mp4"); /* = 上一轮改完写回 node.outputPath 的样子 */
  eq(r.filename, "out#2.mp4", "outputPath 已是 out#1.mp4 → 下一轮 out#2.mp4");
  FILES.add("D:/out/out#2.mp4");
  r = await alloc("out#1.mp4");
  eq(r.filename, "out#3.mp4", "再跑一轮 → out#3.mp4，绝不出现 out#1#1.mp4");

  FILES.clear();
  FILES.add("D:/out/out_1.mp4");
  FILES.add("D:/out/out_1_1.mp4");
  r = await alloc("out_1_1.mp4"); /* 旧实现留下的污染路径 */
  eq(r.filename, "out#1.mp4", "旧污染 out_1_1.mp4 → 治愈回 out#1.mp4");
  FILES.add("D:/out/out#1.mp4");
  r = await alloc("out_1_1.mp4");
  eq(r.filename, "out#2.mp4", "再撞 → out#2.mp4（# 编号递增）");
  ok(r.filename.indexOf("_1") < 0, "产物名里不再出现 _1 式后缀");

  FILES.clear();
  FILES.add("D:/out/曲.wav");
  FILES.add("D:/out/曲#1.wav");
  FILES.add("D:/out/曲#2.wav");
  r = await alloc("曲.wav");
  eq(r.filename, "曲#3.wav", "音频节点同口径（.wav 也按 #N 递增）");
  ok(r.path === "D:/out/曲#3.wav", "exp.path 同步指向实际落点");

  section("[4] 抽卡多次：take 标记同样是 #1、#2");
  const suffix = G("mediaGenRollSuffix");
  eq(suffix(1), "#1", "第 1 个 take → #1");
  eq(suffix(2), "#2", "第 2 个 take → #2");
  eq(suffix(10), "#10", "第 10 个 take → #10（不补零）");
  const roll = G("resolveMediaGenRollExport");
  CURRENT_EXP = mkExp("out.mp4");
  eq(roll(null, 1, 3).filename, "out#1.mp4", "抽卡 3 次的第 1 发 → out#1.mp4");
  eq(roll(null, 3, 3).filename, "out#3.mp4", "抽卡 3 次的第 3 发 → out#3.mp4");
  CURRENT_EXP = mkExp("out#1.mp4"); /* 上一轮已把带标记的路径写回节点 */
  eq(roll(null, 1, 2).filename, "out#1.mp4", "配置名带旧标记 → 剥掉再编号（不是 out#1#1）");
  eq(roll(null, 2, 2).filename, "out#2.mp4", "配置名带旧标记 → 第 2 发 out#2.mp4");
  CURRENT_EXP = mkExp("out.mp4");
  eq(roll(null, 1, 1).filename, "out.mp4", "单发仍用配置名（不加标记）");

  section("[5] 四个宿主 uniqueFileInDir 同口径（真源函数 + 假 FS）");
  for (const host of HOSTS) {
    const src = read(host);
    const label = host.split("/")[0];
    const files = new Set();
    const hb = {
      console, Math, JSON, String, Number, Boolean, RegExp, Object, Array, Error,
      mk: () => {},
      join: (d, f) => String(d || "").replace(/[\\/]+$/, "") + "/" + f,
      fs: { existsSync: (p) => files.has(String(p)) },
    };
    vm.createContext(hb);
    vm.runInContext(extract(src, ["takeStemParts", "uniqueFileInDir"]), hb);
    const u = hb.uniqueFileInDir;

    let x = u("D:/o", "v.mp4", ".mp4");
    eq(x.filename, "v.mp4", label + "：目标不存在 → 原名");
    ok(!x.renamed, label + "：目标不存在 → renamed=false");

    files.add("D:/o/v.mp4");
    x = u("D:/o", "v.mp4", ".mp4");
    eq(x.filename, "v#1.mp4", label + "：已有 v.mp4 → v#1.mp4");

    files.add("D:/o/v#1.mp4");
    x = u("D:/o", "v.mp4", ".mp4");
    eq(x.filename, "v#2.mp4", label + "：v.mp4 + v#1.mp4 都在 → v#2.mp4");

    files.add("D:/o/v#2.mp4");
    x = u("D:/o", "v#2.mp4", ".mp4");
    eq(x.filename, "v#3.mp4", label + "：已是 v#2.mp4 → v#3.mp4（递增、不叠 _1）");
    ok(x.path === "D:/o/v#3.mp4", label + "：path 与 filename 一致");

    const files2 = new Set(["D:/o/v_1.mp4", "D:/o/v_1_1.mp4"]);
    const hb2 = Object.assign({}, hb, { fs: { existsSync: (p) => files2.has(String(p)) } });
    vm.createContext(hb2);
    vm.runInContext(extract(src, ["takeStemParts", "uniqueFileInDir"]), hb2);
    eq(hb2.uniqueFileInDir("D:/o", "v_1_1.mp4", ".mp4").filename, "v#1.mp4", label + "：旧污染 v_1_1.mp4 → v#1.mp4");

    hasnt(src, 'baseStem + "_" + i + ext', label + "：旧的 _i 贴后缀已移除");
    has(src, 'head + "#" + i + ext', label + "：新口径 #i 贴后缀在位");
  }

  section("[6] 文案口径：#1、#2 说齐，_01、_02 清零");
  const I18N = read("renderer/i18n.js");
  const NODES = read("renderer/app-nodes.js");
  const CANVAS = read("renderer/app-canvas.js");
  has(I18N, "连续生成次数（1–10）；多次时输出命名为 #1、#2 …", "i18n 中文词条已改 #1、#2");
  has(I18N, "multiple runs save as #1, #2 …", "i18n 英文词条已改 #1, #2");
  has(I18N, "连续处理次数（1–10）；多次时输出命名为 #1、#2 …", "i18n 超分 / 补帧中文词条已改");
  has(I18N, "multiple passes are named #1, #2 …", "i18n 超分 / 补帧英文词条已改");
  hasnt(I18N, "_01", "i18n 不再残留 _01");
  hasnt(NODES, "_01、_02 …", "设置 tooltip 不再残留 _01、_02");
  hasnt(CANVAS, "_01、_02 …", "超分 / 补帧 tooltip 不再残留 _01、_02");
  eq((NODES.match(/多次时输出命名为 #1、#2/g) || []).length, 3, "生成族 3 处 tooltip 齐（music/tts/video/remotion · yue · sensenova）");
  eq((CANVAS.match(/多次时输出命名为 #1、#2/g) || []).length, 2, "后处理 2 处 tooltip 齐");
  for (const g of [
    "guides/nodes/video_upscale.md",
    "guides/nodes/video_interp.md",
    "guides/nodes/yue_gen.md",
    "guides/nodes/sensenova_gen.md",
    "guides/nodes/en/video_upscale.md",
    "guides/nodes/en/video_interp.md",
    "guides/nodes/en/yue_gen.md",
    "guides/nodes/en/sensenova_gen.md",
    "guides/manual/media-gen.md",
  ]) {
    hasnt(read(g), "_01", g + " 指南已改 #1、#2");
  }
  has(read("mtnode-agent-skills/mtnode/media-gen-nodes/SKILL.md"), "`#1`、`#2`", "技能 mtnode-media-gen-nodes 已改 #1、#2");
  has(read("sensenova/main-sensenova.js"), 'roll = Number.isFinite(n) && n >= 1 ? "#"', "SenseNova 资产命名同口径（#N）");

  console.log("\n" + (fails ? "FAIL" : "PASS") + " · " + (checks - fails) + "/" + checks);
  process.exit(fails ? 1 : 0);
})();
/* plugins/plugin-kit-sync.js — 控制台窗共享样式表（plugin-kit.css）的运行时同步真源
 *
 * 为什么要有：控制台页在应用内是 <app>/<plugin>/ui/index.html，页面里
 *   <link rel="stylesheet" href="../../plugins/plugin-kit.css">
 * 解析到 <app>/plugins/plugin-kit.css —— 那份随包就有，应用内直接加载时一切正常。
 *
 * 但有 6 个后端插件（h3 / music3 / yue / llama / breeze / remotion）会把 ui/ 复制到
 *   <数据目录>/<plugin>/ui/ 再 loadFile（见各自 main-*.js 的 ensureUiRuntime）。同一个相对
 * 路径此时变成 <数据目录>/plugins/plugin-kit.css —— 这份文件没人建，页面拿到的是一张
 * 不存在的样式表：所有令牌 / 控件类全丢，整窗退化成白底 + 原生灰白控件（2026-11 现场）。
 *
 * 所以：ensureUiRuntime() 复制完 ui/ 之后，必须把这个 css 放到「页面相对路径算出来的那个落点」。
 * 口径只此一处 —— 落点由 ui 目录反推（<ui>/../../plugins/plugin-kit.css），与页面里的相对路径
 * 天然同源，插件目录名 / 数据目录 / 页面层级都不用在这里再写一遍。
 * 应用内加载（ui 目录就在 <app>/<plugin>/ui）时反推结果正好是随包那份源文件本身：读到内容
 * 相同 → 不写盘，纯读，不碰应用目录。
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** 随包的 kit 样式表（本模块就在 plugins/ 里，与它同级）。 */
const SRC = path.join(__dirname, "plugin-kit.css");

/* 源文件内容缓存：每次开窗都 stat 一次，内容真变了（换了 kit）才重读。
   18KB 一份，6 个窗各开一次也不该反复读盘。 */
let cache = null; // { mtimeMs, size, buf }

function readKit() {
  let st;
  try {
    st = fs.statSync(SRC);
  } catch {
    return null;
  }
  if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.buf;
  try {
    const buf = fs.readFileSync(SRC);
    cache = { mtimeMs: st.mtimeMs, size: st.size, buf };
    return buf;
  } catch {
    return null;
  }
}

/** ui 目录 → 页面里 ../../plugins/plugin-kit.css 的真实落点。 */
function kitDestFor(uiDir) {
  const dir = String(uiDir || "").trim();
  if (!dir) return "";
  return path.resolve(dir, "..", "..", "plugins", "plugin-kit.css");
}

/**
 * 保证「该 ui 目录里的页面」能找到它的 kit 样式表。
 * 幂等：内容相同就跳过（只读一次 compare），不写盘也不动 mtime。
 * 返回 { ok, dest, changed, skipped, error }：
 *   · skipped=true = 落点就是随包源文件本身（应用内加载），不需要同步；
 *   · changed=true = 这次真的写了一份（调用方据此决定要不要 reload 已开着的窗）。
 */
function ensureKitForUiDir(uiDir) {
  const dest = kitDestFor(uiDir);
  if (!dest) return { ok: false, dest: "", changed: false, skipped: false, error: "no_ui_dir" };
  if (path.resolve(dest) === path.resolve(SRC)) {
    return { ok: true, dest, changed: false, skipped: true, error: "" };
  }
  const buf = readKit();
  if (!buf) return { ok: false, dest, changed: false, skipped: false, error: "kit_missing" };
  let same = false;
  try {
    same = fs.readFileSync(dest).equals(buf);
  } catch {}
  if (same) return { ok: true, dest, changed: false, skipped: false, error: "" };
  const tmp = dest + ".tmp" + process.pid;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    return { ok: true, dest, changed: true, skipped: false, error: "" };
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return { ok: false, dest, changed: false, skipped: false, error: String((e && e.message) || e) };
  }
}

module.exports = { SRC, kitDestFor, ensureKitForUiDir };

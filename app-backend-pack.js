"use strict";
/**
 * 应用自带的本地后端（`<appDir>/backend/backend.json` + 源码）
 *
 * 为什么要这一层：应用页只有 tools.list / tools.call，没有 exec、没有注册表写权、
 * 也写不了数据目录 —— 所以「新用户打开应用就有一个能跑的后端」不可能靠页面自己完成。
 * 现在的口径（用户共识）：
 *   ① 源码随应用包走：应用目录里放一份 `backend/`（backend.json + server.mjs），
 *      装应用 / 升级应用时由宿主铺到 `<数据目录>/backends/<id>/`，**只铺源码**；
 *   ② 登记与起服务归注册中心：应用首次打开调 `tools.install(id)`，宿主校验落盘 →
 *      登记（launch 用 Electron 自带 node，不再写死开发机路径）→ 起服务 → 等 /health；
 *   ③ 升级只覆盖源码，`work/`（用户源码与产物）与 `runtime/`（已下的 Tectonic 资源包）
 *      一律不动；卸载应用也不删后端目录（它归注册中心管，面板里手动删）。
 *
 * 本模块只碰磁盘、不起进程、不写注册表 —— 注册与启动在 main-backend-registry.js。
 */

const fs = require("fs");
const path = require("path");

const PACK_DIR = "backend";
const PACK_FILE = "backend.json";
const PACK_MARK = "pack.json";
const BACKENDS_SUBDIR = "backends";
const ID_OK = /^[a-z0-9][a-z0-9._-]{0,47}$/i;

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}

function s(v) {
  return v == null ? "" : String(v);
}

function backendsRoot(dataDir) {
  return path.join(s(dataDir), BACKENDS_SUBDIR);
}

/** 读一个应用自带的清单；没有 / 坏了 / 入口文件不在都回 ok:false（调用方据此说人话）。 */
function readPack(appDir) {
  const dir = path.join(s(appDir), PACK_DIR);
  const raw = readJson(path.join(dir, PACK_FILE), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "这个应用没有自带后端（缺 " + PACK_DIR + "/" + PACK_FILE + "）" };
  const id = s(raw.id).trim();
  if (!ID_OK.test(id)) return { ok: false, error: "后端清单的 id 非法：" + (id || "（空）") };
  const entry = s(raw.entry || "server.mjs").replace(/[\\/]+/g, "");
  if (!entry) return { ok: false, error: "后端清单缺 entry（入口文件名）" };
  const entryPath = path.join(dir, entry);
  if (!fs.existsSync(entryPath)) return { ok: false, error: "后端目录里没有入口文件：" + entry };
  return {
    ok: true,
    pack: Object.assign({}, raw, { id: id, entry: entry }),
    srcDir: dir,
    srcEntry: entryPath,
  };
}

function targetDirOf(dataDir, id) {
  return path.join(backendsRoot(dataDir), s(id));
}

/**
 * 把应用包里的后端铺到数据目录（幂等）。
 * 版本号相同且入口文件在 = 什么都不做；否则把 backend/ 里的源码文件覆盖一遍
 * （**不删**目标目录里已有的东西 —— work/ 与 runtime/ 是用户资产）。
 */
function syncPack(appDir, dataDir, opts) {
  const o = opts || {};
  const r = readPack(appDir);
  if (!r.ok) return r;
  if (!s(dataDir)) return { ok: false, error: "没有数据目录，铺不了后端" };
  const pack = r.pack;
  const dir = targetDirOf(dataDir, pack.id);
  const mark = readJson(path.join(dir, PACK_MARK), null) || {};
  const version = s(pack.version || "");
  const entryInPlace = fs.existsSync(path.join(dir, pack.entry));
  const sameVersion = version && s(mark.version) === version;
  const needCopy = !entryInPlace || !sameVersion || o.force === true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (needCopy) {
      for (const name of fs.readdirSync(r.srcDir)) {
        const src = path.join(r.srcDir, name);
        let st = null;
        try {
          st = fs.statSync(src);
        } catch {
          continue;
        }
        if (!st || !st.isFile()) continue;
        if (name === PACK_FILE) continue;
        fs.copyFileSync(src, path.join(dir, name));
      }
    }
    fs.writeFileSync(
      path.join(dir, PACK_MARK),
      JSON.stringify(
        {
          id: pack.id,
          version: version,
          entry: pack.entry,
          appDir: path.resolve(s(appDir)),
          syncedAt: Date.now(),
          changed: needCopy,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    return { ok: false, error: "铺后端失败：" + ((err && err.message) || err) };
  }
  return {
    ok: true,
    id: pack.id,
    dir: dir,
    version: version,
    changed: needCopy,
    pack: pack,
  };
}

/**
 * 清单 → 注册中心条目（backend-registry-store 的 normalizeManifest 形状）。
 * nodeExe = 跑后端的解释器（生产传 process.execPath + ELECTRON_RUN_AS_NODE，别写死 node 路径）。
 */
function packManifest(sync, nodeExe) {
  const pack = (sync && sync.pack) || {};
  const dir = s(sync && sync.dir);
  const launch = pack.launch && typeof pack.launch === "object" ? pack.launch : {};
  const entry = path.join(dir, s(pack.entry || "server.mjs"));
  const rawCmd =
    Array.isArray(launch.cmd) && launch.cmd.length ? launch.cmd : ["{node}", "{entry}", "--port", "{port}"];
  const cmd = rawCmd.map((part) =>
    s(part)
      .replace(/\{node\}/g, s(nodeExe))
      .replace(/\{entry\}/g, entry),
  );
  const health = launch.health && typeof launch.health === "object" ? launch.health : {};
  const portRange = Array.isArray(launch.portRange) ? launch.portRange : [];
  const install = pack.install && typeof pack.install === "object" ? pack.install : {};
  return {
    id: s(pack.id),
    name: s(pack.name || pack.id),
    kind: "http",
    desc: s(pack.desc),
    args: Array.isArray(pack.args) ? pack.args : [],
    returns: Array.isArray(pack.returns) ? pack.returns : [{ name: "text", kind: "text" }],
    source: "managed",
    launch: {
      cmd: cmd,
      cwd: dir,
      portRange: portRange.length >= 2 ? portRange : [17800, 17899],
      portFlag: s(launch.portFlag || "--port"),
      health: { path: s(health.path || "/health"), timeoutSec: Number(health.timeoutSec) || 60 },
      readyLine: s(launch.readyLine || "listening on"),
      restartOnCrash: launch.restartOnCrash !== false,
      maxRestarts: Number(launch.maxRestarts) || 3,
      env: launch.env && typeof launch.env === "object" ? launch.env : { ELECTRON_RUN_AS_NODE: "1" },
    },
    call: pack.call && typeof pack.call === "object" ? pack.call : { method: "POST", path: "/call", timeoutSec: 900 },
    lock: pack.lock && typeof pack.lock === "object" ? pack.lock : { class: "cpu", exclusive: true },
    install: {
      dir: dir,
      sizeGB: Number(install.sizeGB) || 0,
      from: "app",
      note: s(install.note),
    },
  };
}

module.exports = {
  PACK_DIR: PACK_DIR,
  PACK_FILE: PACK_FILE,
  BACKENDS_SUBDIR: BACKENDS_SUBDIR,
  backendsRoot: backendsRoot,
  targetDirOf: targetDirOf,
  readPack: readPack,
  syncPack: syncPack,
  packManifest: packManifest,
};

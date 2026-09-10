"use strict";
/* 桌宠独立进程：必须带 --mtnode-pet（勿用环境变量判角色，避免污染主程序启动） */
if (process.argv.includes("--mtnode-pet")) {
  require("./pet/standalone-main.js");
  return;
}
/* llama.cpp 托盘独立进程：不随 MTNode 退出 */
if (process.argv.includes("--mtnode-llama-tray")) {
  require("./llama/tray-main.js");
  return;
}
/* GPT-SoVITS TTS 托盘独立进程：不随 MTNode 退出 */
if (process.argv.includes("--mtnode-tts-tray")) {
  require("./tts/tray-main.js");
  return;
}

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
  nativeImage,
  screen,
  safeStorage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { launchDetached } = require("./main-exec-launch.js");
/* 隐藏进程宿主：运行期拉起的外部进程统一隐藏启动 + 按 runId 记账 + 随运行/退出回收 */
const procHost = require("./main-proc-host.js");
/* 函数节点运行时：一次运行 = 一个 worker 线程 + 一个 runId
   （用户 JS 不再在渲染进程主线程同步执行 —— 修复「跑函数节点把 MTNode 锁死」） */
const { createFnRuntime } = require("./fn-runtime.js");
const zlib = require("zlib");
const http = require("http");
const https = require("https");
const { pathToFileURL } = require("url");
/* gifenc 延迟加载：模块缺失时仅影响 GIF 生成，不会导致启动崩溃 */
let _gifenc = null;
function gifenc() {
  if (!_gifenc) _gifenc = require("gifenc");
  return _gifenc;
}

/* dsh agent 适配器（网关侧车）：全部 dsh 能力经此模块，契约见 dsh/DESIGN.md。
   本文件与渲染层不 import 任何 dsh 代码，dsh 升级只触及 dsh/gateway/。 */
const { createDshAdapter } = require("./dsh/main-dsh.js");
const I18n = require("./renderer/i18n.js");
const {
  registerUpdateIpc,
  startBackgroundCheck,
} = require("./updater.js");
const { registerPetIpc, shutdownPet } = require("./pet/main-pet.js");
const { registerAppPluginsIpc, shutdownAppPlugins, openWindowPlugin } = require("./plugins/main-app-plugins.js");
const { registerMusic3Ipc, shutdownMusic3UiOnly } = require("./music3/main-music3.js");
const { registerH3Ipc, shutdownH3UiOnly } = require("./h3/main-h3.js");
const { refreshStaleLock: refreshMediaGenLock } = require("./media-gen-global-lock.js");
const { registerLlamaIpc, shutdownLlamaUiOnly } = require("./llama/main-llama.js");
const { registerTtsIpc, shutdownTtsUiOnly } = require("./tts/main-tts.js");
const { registerRemotionIpc, shutdownRemotionUiOnly } = require("./remotion/main-remotion.js");
const { patchProviders } = require("./config-providers.js");
const { registerRollbackIpc } = require("./rollback-store.js");
const { registerToolsIpc } = require("./tools-store.js");
const { registerAssetsIpc } = require("./assets-store.js");
/* 本机微信 PC 版检测 / 启动：纯主进程、零新依赖，不做注入与本地数据读取 */
const wechatPc = require("./wechat-pc.js");
let dshAdapter = null;
function dshConfig() {
  const cfg = readJson(join(DATA(), "config.json"), {});
  const d = cfg.dsh || {};
  return {
    enabled: d.enabled !== false,
    nodePath: typeof d.nodePath === "string" ? d.nodePath : "",
    model: typeof d.model === "string" && d.model ? d.model : "deepseek-v4-flash",
    maxTokens: (() => {
      const n = Number(d.maxTokens);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    })(),
    defaultWorkspace: typeof d.defaultWorkspace === "string" ? d.defaultWorkspace : "",
    workspaceFallback: join(DATA(), "dsh-workspace"),
  };
}
function dshLog(p) {
  try {
    fs.appendFileSync(join(DATA(), "dsh.log"), "[" + new Date().toISOString() + "] " + p + "\n");
  } catch {}
}
function dsh() {
  if (!dshAdapter) {
    dshAdapter = createDshAdapter({
      dataDir: DATA(),
      appRoot: __dirname,
      errLog,
      log: dshLog,
      onEvent: (ev) => {
        if (mainWin && !mainWin.isDestroyed()) {
          /* 全部事件原样转发（含 reqId 为空的帧）：网关撤销「无在途归属」的提问 /
             审批卡时发的 ix-drop 就是 reqId:'' 的全局撤卡帧，它不属于任何一次 run
             的事件流，渲染层由 preload.dshOnIxDrop 在全局通道上按 id 兜底撤卡。 */
          mainWin.webContents.send("dsh:event", ev);
        }
        try {
          const { onMusic3DshEvent } = require("./music3/main-music3.js");
          if (typeof onMusic3DshEvent === "function") onMusic3DshEvent(ev);
        } catch {}
        try {
          const { onLlamaDshEvent } = require("./llama/main-llama.js");
          if (typeof onLlamaDshEvent === "function") onLlamaDshEvent(ev);
        } catch {}
        try {
          const { onTtsDshEvent } = require("./tts/main-tts.js");
          if (typeof onTtsDshEvent === "function") onTtsDshEvent(ev);
        } catch {}
      },
    });
  }
  return dshAdapter;
}

const mk = (p) => {
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const join = (...a) => path.join(...a);

/* 默认 userData 固定在 appData/pipeline-console；可配置的「配置数据目录」
   （config.json / API Key / 工作流等）经指针文件指向，指针本身不可随数据目录迁移。 */
const APP_DATA_ROOT = path.join(app.getPath("appData"), "pipeline-console");
const DATA_ROOT_POINTER = path.join(APP_DATA_ROOT, "data-root.json");

function readDataRootOverride() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_ROOT_POINTER, "utf8"));
    const p = j && typeof j.path === "string" ? String(j.path).trim() : "";
    if (p && path.isAbsolute(p)) return path.resolve(p);
  } catch {}
  return null;
}

app.setPath(
  "userData",
  process.env.MTNODE_DATA_DIR || APP_DATA_ROOT,
);

function defaultDataDir() {
  return path.join(app.getPath("userData"), "pipeline-console");
}

/* 启动时解析一次：改目录后需重启才生效 */
const RESOLVED_DATA_DIR = (() => {
  if (process.env.MTNODE_DATA_DIR) return defaultDataDir();
  return readDataRootOverride() || defaultDataDir();
})();
const DATA = () => RESOLVED_DATA_DIR;

function applyMainLocale(l) {
  I18n.setLocale(l === "en" ? "en" : "zh");
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setTitle(I18n.t("MTNode AI编排器 · MTNode AI Orchestrator"));
  }
}
function localeFromDisk() {
  try {
    const cfg = readJson(join(DATA(), "config.json"), {});
    return cfg && cfg.locale === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

let mainWin = null;
function win() {
  return mainWin;
}

const crashReport = require("./crash-report");
crashReport.init({
  getDataDir: DATA,
  getVersion: () => {
    try {
      return appVersion();
    } catch {
      return app.getVersion();
    }
  },
  t: (s) => I18n.t(s),
});
/* 尽早挂上，避免启动阶段异常漏记 */
crashReport.installProcessHandlers();

function errLog(p) {
  crashReport.errLog(p);
}

/* ---------------- 磁盘工具 ---------------- */

function readJson(p, fb = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function backupConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) return;
    const bakDir = join(path.dirname(configPath), "config-backups");
    mk(bakDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(bakDir, "config-" + stamp + ".json");
    fs.copyFileSync(configPath, dest);
    const files = fs
      .readdirSync(bakDir)
      .filter((f) => f.startsWith("config-") && f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(join(bakDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(30)) {
      try {
        fs.unlinkSync(join(bakDir, old.f));
      } catch {}
    }
  } catch {}
}
const wfIdOk = (id) => /^[A-Za-z0-9_-]{4,120}$/.test(String(id || ""));
const wfPath = (id) => join(DATA(), "save", String(id) + ".json");
/* 只算路径不建目录：删除 / 校验一类的只读路径必须无副作用（assetDir 会 mkdir） */
const assetDirPath = (wfId) => join(DATA(), "assets", String(wfId));
const assetDir = (wfId) => mk(assetDirPath(wfId));
/* 误删画布的回收站：save/<id>.json + assets/<id> 整体搬进 trash/<时间戳>__<id>/ */
const TRASH_DIR = () => join(DATA(), "trash");

/* ── 画布备份：每 5 分钟把 save/ 里各工作流 JSON 快照到独立的 save-backups/ 文件夹 ──
   与自动保存链路完全解耦：只做只读复制，绝不写 save/。copyFileSync 保留源文件
   mtime，因此「源 mtime ≤ 最新备份 mtime」即表示上次备份后无改动，直接跳过；
   每条工作流保留最近 72 份（≈6 小时），误删/改坏可从备份文件夹手工找回。 */
const WF_BACKUP_DIR = () => join(DATA(), "save-backups");
const WF_BACKUP_MS = 5 * 60 * 1000;
const WF_BACKUP_KEEP = 72;

function workflowBackupTick() {
  try {
    const srcDir = mk(join(DATA(), "save"));
    const bakRoot = mk(WF_BACKUP_DIR());
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!wfIdOk(id)) continue;
      const src = join(srcDir, f);
      let st;
      try {
        st = fs.statSync(src);
      } catch {
        continue;
      }
      const dir = mk(join(bakRoot, id));
      let files = [];
      try {
        files = fs
          .readdirSync(dir)
          .filter((b) => b.startsWith(id + "-") && b.endsWith(".json"))
          .map((b) => ({ b, t: fs.statSync(join(dir, b)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
      } catch {}
      if (files.length && st.mtimeMs <= files[0].t) continue;
      const name = id + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      try {
        fs.copyFileSync(src, join(dir, name));
      } catch {
        continue;
      }
      files = [{ b: name, t: st.mtimeMs }].concat(files);
      for (const old of files.slice(WF_BACKUP_KEEP)) {
        try {
          fs.unlinkSync(join(dir, old.b));
        } catch {}
      }
    }
  } catch {
    /* 备份失败绝不影响应用 */
  }
}

function workflowBackupStatus() {
  try {
    const dir = mk(WF_BACKUP_DIR());
    let count = 0;
    let latest = 0;
    for (const id of fs.readdirSync(dir)) {
      try {
        const d = join(dir, id);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const b of fs.readdirSync(d)) {
          if (!b.endsWith(".json")) continue;
          count++;
          const s = fs.statSync(join(d, b));
          const born = s.birthtimeMs || s.mtimeMs;
          if (born > latest) latest = born;
        }
      } catch {}
    }
    return { ok: true, dir, count, latest };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/* 一次性迁移：旧版本工作流在 workflows/ 下，新版本统一存到 save/ */
function migrateLegacyWorkflows() {
  const oldDir = join(DATA(), "workflows");
  const newDir = join(DATA(), "save");
  try {
    if (!fs.existsSync(newDir)) return;
    if (fs.readdirSync(newDir).some((f) => f.endsWith(".json"))) return;
    if (fs.existsSync(oldDir)) {
      for (const f of fs.readdirSync(oldDir)) {
        if (f.endsWith(".json"))
          fs.renameSync(join(oldDir, f), join(newDir, f));
      }
    }
  } catch {
    /* 迁移失败不影响启动 */
  }
}

/* ---------------- IPC：配置 / 工作流 ---------------- */

/* 从源码目录读取 version 文件（打包后随 asar 携带，与构建时引用同一份） */
function appVersion() {
  try {
    const v = fs.readFileSync(join(__dirname, "version"), "utf8").trim();
    return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
ipcMain.handle("app:version", () => ({ ok: true, version: appVersion() }));
ipcMain.handle("mediaGen:getLock", () => ({ ok: true, lock: refreshMediaGenLock() }));
ipcMain.handle("crash:status", () => crashReport.status());
ipcMain.handle("crash:export", async () => crashReport.exportDiagnosticBundle({}));
ipcMain.handle("crash:openLogs", () => crashReport.openLogsFolder());
ipcMain.handle("crash:logRenderer", (e, payload) =>
  crashReport.logRendererError(payload || {}),
);
function loadMarkdownPack(root, id, locale) {
  const safe = String(id || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) return { ok: false, error: "bad id" };
  const loc = String(locale || "").toLowerCase().startsWith("en") ? "en" : "zh";
  const candidates = [];
  if (loc === "en") candidates.push(join(root, "en", safe + ".md"));
  candidates.push(join(root, safe + ".md"));
  let mdPath = "";
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      mdPath = p;
      break;
    }
  }
  if (!mdPath) return { ok: false, error: "missing", id: safe };
  let markdown = "";
  try {
    markdown = fs.readFileSync(mdPath, "utf8");
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  const assets = {};
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(markdown))) {
    const rel = String(m[1] || "").trim().replace(/\\/g, "/");
    if (!rel || rel.indexOf("..") >= 0 || /^[a-z]+:/i.test(rel)) continue;
    const abs = join(root, rel);
    const normRoot = root.replace(/\\/g, "/").toLowerCase();
    const normAbs = abs.replace(/\\/g, "/").toLowerCase();
    if (normAbs !== normRoot && !normAbs.startsWith(normRoot + "/")) continue;
    if (!fs.existsSync(abs)) continue;
    try {
      const buf = fs.readFileSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".svg"
          ? "image/svg+xml"
          : ext === ".png"
            ? "image/png"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gif"
                ? "image/gif"
                : ext === ".jpg" || ext === ".jpeg"
                  ? "image/jpeg"
                  : "application/octet-stream";
      assets[rel] = "data:" + mime + ";base64," + buf.toString("base64");
    } catch (_) {}
  }
  return { ok: true, id: safe, markdown, assets };
}

function docsManualRoot() {
  return join(__dirname, "guides", "manual");
}

function loadDocsCatalog() {
  const p = join(docsManualRoot(), "index.json");
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || !Array.isArray(raw.sections))
      return { ok: false, error: "bad catalog" };
    return { ok: true, catalog: raw };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

ipcMain.handle("guide:load", (e, opts) => {
  opts = opts || {};
  return loadMarkdownPack(
    join(__dirname, "guides", "nodes"),
    opts.id,
    opts.locale,
  );
});
ipcMain.handle("docs:catalog", () => loadDocsCatalog());
ipcMain.handle("docs:load", (e, opts) => {
  opts = opts || {};
  return loadMarkdownPack(docsManualRoot(), opts.id, opts.locale);
});
ipcMain.handle("docs:bundle", (e, opts) => {
  opts = opts || {};
  const cat = loadDocsCatalog();
  if (!cat.ok) return cat;
  const locale = String(opts.locale || "").toLowerCase().startsWith("en")
    ? "en"
    : "zh";
  const locKey = locale === "en" ? "en" : "zh";
  const parts = [];
  let total = 0;
  const MAX = 80000;
  const PAGE_MAX = 4500;
  const sections = (cat.catalog && cat.catalog.sections) || [];
  for (const sec of sections) {
    const secTitle =
      (sec.title && (sec.title[locKey] || sec.title.zh || sec.title.en)) ||
      sec.id ||
      "";
    for (const page of sec.pages || []) {
      if (total >= MAX) break;
      const pid = page && page.id;
      const pack = loadMarkdownPack(docsManualRoot(), pid, locale);
      if (!pack.ok) continue;
      const pageTitle =
        (page.title && (page.title[locKey] || page.title.zh || page.title.en)) ||
        pid;
      let body = String(pack.markdown || "")
        .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
        .trim();
      if (body.length > PAGE_MAX) body = body.slice(0, PAGE_MAX) + "\n…";
      const chunk =
        "\n\n## " + secTitle + " / " + pageTitle + "\n\n" + body;
      if (total + chunk.length > MAX) {
        parts.push(chunk.slice(0, Math.max(0, MAX - total)));
        total = MAX;
        break;
      }
      parts.push(chunk);
      total += chunk.length;
    }
  }
  return { ok: true, text: parts.join(""), bytes: total };
});
ipcMain.handle("i18n:setLocale", (e, locale) => {
  applyMainLocale(locale);
  return { ok: true, locale: I18n.getLocale() };
});

ipcMain.handle("config:load", () =>
  readJson(join(DATA(), "config.json"), {
    version: 1,
    snap: 24,
    activeWorkflowId: "default",
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        type: "text_openai",
        baseUrl: "https://api.deepseek.com",
        apiKey: "",
        models: [
          "deepseek-v4-flash",
          "deepseek-v4-pro",
          "deepseek-v4-flash-vision-exp",
        ],
        vision: false,
      },
      {
        id: "gpt_image_2",
        name: "GPT Image 2",
        type: "image_openai",
        baseUrl: "",
        apiKey: "",
        models: ["gpt-image-2-vip"],
      },
    ],
  }),
);
ipcMain.handle("config:save", (e, cfg) => {
  const fp = join(DATA(), "config.json");
  backupConfigFile(fp);
  const existing = readJson(fp, {}) || {};
  const incoming = cfg || {};
  const next = Object.assign({}, existing, incoming);
  if (Array.isArray(incoming.providers)) {
    const managed = (existing.providers || []).filter(
      (p) =>
        p &&
        (p.source === "llama-plugin" ||
          p.id === "llama-local" ||
          p.source === "tts-plugin" ||
          p.id === "tts-local"),
    );
    const saved = incoming.providers.slice();
    const savedIds = new Set(saved.map((p) => String(p.id || "")));
    for (const p of managed) {
      if (!savedIds.has(String(p.id || ""))) saved.push(p);
    }
    next.providers = saved;
  }
  writeJson(fp, next);
  if (next && (next.locale === "en" || next.locale === "zh")) applyMainLocale(next.locale);
  return { ok: true };
});
ipcMain.handle("config:patchProviders", (e, opts) =>
  patchProviders(join(DATA(), "config.json"), opts || {}),
);

ipcMain.handle("workflow:list", () => {
  const d = mk(join(DATA(), "save"));
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const j = readJson(join(d, f), {});
      const id = j.id || f.slice(0, -5);
      let mtime = 0;
      try {
        mtime = fs.statSync(join(d, f)).mtimeMs;
      } catch {}
      return { id, name: j.name || id, mtime, nodes: (j.nodes || []).length };
    })
    .sort((a, b) => b.mtime - a.mtime);
});
ipcMain.handle("workflow:load", (e, id) => {
  if (!wfIdOk(id)) return { ok: false, error: I18n.t("非法工作流 id") };
  const j = readJson(wfPath(id));
  return j ? { ok: true, data: j } : { ok: false, error: I18n.t("工作流不存在") };
});
ipcMain.handle("workflow:save", (e, { id, data }) => {
  if (!wfIdOk(id)) return { ok: false, error: I18n.t("非法工作流 id") };
  writeJson(wfPath(id), data);
  return { ok: true, mtime: Date.now() };
});
/* target 是否严格位于 parentDir 之下（parentDir 本身算越界）。
   一律用 path.resolve 后的绝对路径比较，防 .. / 大小写别名绕过。 */
function pathStrictlyUnder(parentDir, target) {
  const p = path.resolve(parentDir);
  const t = path.resolve(target);
  return t.length > p.length && t.startsWith(p + path.sep);
}

/* 磁盘占用指纹（文件数 + 总字节），用于回收站复制后的完整性校验 */
function diskFootprint(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(p)) {
    const sub = diskFootprint(join(p, name));
    files += sub.files;
    bytes += sub.bytes;
  }
  return { files, bytes };
}

/* 把 src 搬进回收站 dest：首选同盘 rename（原子、零拷贝）；
   rename 失败（被占用 EPERM/EBUSY、跨卷 EXDEV）退化为同盘 copy + 指纹校验，
   校验通过才尽力移除源文件。任何一步不如预期都如实返回 { ok:false, code }，
   绝不静默物理删。 */
function trashMove(src, dest) {
  const errors = [];
  let renamedTo = null;
  try {
    fs.renameSync(src, dest);
    renamedTo = dest;
  } catch (err) {
    errors.push(String((err && err.code) || err));
    const alt =
      dest + ".trash" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      fs.renameSync(src, alt);
      renamedTo = alt;
    } catch (err2) {
      errors.push(String((err2 && err2.code) || err2));
    }
  }
  if (renamedTo) return { ok: true, dest: renamedTo };

  /* rename 走不通：复制进同盘回收站，校验一致后再移除源 */
  const cdest =
    dest + ".copy" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    fs.cpSync(src, cdest, { recursive: true, dereference: true });
    const before = diskFootprint(src);
    const after = diskFootprint(cdest);
    if (before.files !== after.files || before.bytes !== after.bytes)
      return {
        ok: false,
        code: "wf_copy_unverified",
        error: I18n.t("回收站复制校验不一致，画布未删除"),
        dest: cdest,
      };
    try {
      fs.rmSync(src, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        code: "wf_source_locked",
        error:
          I18n.t("画布已复制到回收站，但源文件被占用无法移除；请关闭占用后重试：") +
          cdest,
        copied: true,
        dest: cdest,
      };
    }
    return { ok: true, dest: cdest, copied: true };
  } catch (err) {
    errors.push(String((err && err.message) || err));
    return {
      ok: false,
      code: "wf_move_failed",
      error: I18n.t("移入回收站失败，画布未删除：") + errors.join(" / "),
    };
  }
}

ipcMain.handle("workflow:delete", (e, arg) => {
  /* ── 删除画布：双重校验 + 回收站软删 ─────────────────────────────
     兼容旧调用：arg 可以是 id 字符串；新调用传 { id, expectId, expectName }。
     1) wfIdOk 校验 id；
     2) path.resolve 断言目标严格位于 save/ 与 assets/ 之下，越界一律拒绝；
     3) 读磁盘 json 比对 expectId / expectName，不一致直接拒绝（fail closed，
        返回 code 供 UI 提示），不猜、不只按文件名删；
     4) 不再 rmSync：把 <id>.json 与 assets/<id> 整体 move 进
        trash/<时间戳>__<id>/；rename 失败退化为同盘 copy + 校验，任何失败都
        如实返回，绝不静默物理删；
     5) 成功返回被删画布名与节点数 + 回收站路径，供 UI 显示「可在回收站恢复」。 */
  const opts = arg && typeof arg === "object" ? arg : { id: arg };
  const id = String(opts.id == null ? "" : opts.id);
  const expectId = opts.expectId == null ? "" : String(opts.expectId);
  const expectName = opts.expectName == null ? "" : String(opts.expectName);
  if (!wfIdOk(id))
    return { ok: false, code: "wf_bad_id", error: I18n.t("非法工作流 id") };

  const saveRoot = path.resolve(join(DATA(), "save"));
  const assetsRoot = path.resolve(join(DATA(), "assets"));
  const srcFile = path.resolve(wfPath(id));
  const srcAssets = path.resolve(assetDirPath(id));
  if (!pathStrictlyUnder(saveRoot, srcFile) || !pathStrictlyUnder(assetsRoot, srcAssets))
    return {
      ok: false,
      code: "wf_path_escape",
      error: I18n.t("删除目标不在画布数据目录内，已拒绝"),
    };

  let exists = false;
  try {
    exists = fs.statSync(srcFile).isFile();
  } catch {}
  if (!exists)
    /* 磁盘上本就没有这份画布：与旧行为一致视为删除完成（无事可删） */
    return { ok: true, id, name: expectName || id, nodes: 0, noop: true };

  let diskJson = null;
  try {
    diskJson = JSON.parse(fs.readFileSync(srcFile, "utf8"));
  } catch {
    return {
      ok: false,
      code: "wf_unreadable",
      error: I18n.t("画布文件无法读取，已拒绝删除（请手动检查 save 目录）"),
    };
  }
  if (!diskJson || typeof diskJson !== "object")
    return {
      ok: false,
      code: "wf_unreadable",
      error: I18n.t("画布文件内容异常，已拒绝删除（请手动检查 save 目录）"),
    };

  const diskId = String(diskJson.id || id);
  const shownName = String(diskJson.name || id);
  if ((expectId && diskId !== expectId) || (expectName && shownName !== expectName))
    return {
      ok: false,
      code: "wf_mismatch",
      error:
        I18n.t("画布校验不一致，已拒绝删除：磁盘上是") +
        " " +
        shownName +
        " (id: " +
        diskId +
        ")" +
        I18n.t("，请求要删的是") +
        " " +
        (expectName || shownName) +
        " (id: " +
        (expectId || diskId) +
        ")",
      id,
      name: shownName,
      diskId,
      diskName: shownName,
    };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashRoot = path.resolve(TRASH_DIR());
  const entry = path.resolve(join(trashRoot, stamp + "__" + id));
  if (!pathStrictlyUnder(trashRoot, entry))
    return {
      ok: false,
      code: "wf_path_escape",
      error: I18n.t("回收站目标路径越界，已拒绝"),
    };
  try {
    fs.mkdirSync(entry, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: "wf_trash_failed",
      error: I18n.t("无法创建回收站目录，画布未删除：") + ((err && err.message) || String(err)),
    };
  }

  /* 先搬资产目录，再搬画布 json：任一步失败画布都保持完整（或已回滚） */
  let hadAssets = false;
  try {
    hadAssets = fs.statSync(srcAssets).isDirectory();
  } catch {}
  let assetsDest = null;
  if (hadAssets) {
    const r = trashMove(srcAssets, join(entry, "assets"));
    if (!r.ok)
      return {
        ok: false,
        code: r.code || "wf_move_failed",
        error: r.error,
        id,
        name: shownName,
        trashPath: entry,
      };
    assetsDest = r.dest;
  }
  const rJson = trashMove(srcFile, join(entry, id + ".json"));
  if (!rJson.ok) {
    if (assetsDest) {
      /* 回滚：把已搬走的资产放回原位，宁可删不掉也不能留下半份画布 */
      try {
        fs.mkdirSync(path.dirname(srcAssets), { recursive: true });
        fs.renameSync(assetsDest, srcAssets);
      } catch {}
    }
    return {
      ok: false,
      code: rJson.code || "wf_move_failed",
      error: rJson.error,
      id,
      name: shownName,
      trashPath: entry,
    };
  }

  return {
    ok: true,
    id,
    name: shownName,
    nodes: Array.isArray(diskJson.nodes) ? diskJson.nodes.length : 0,
    trashPath: entry,
    assets: !!hadAssets,
  };
});
/* 画布备份：状态查询与打开备份文件夹（备份文件本身只在定时任务里只读复制） */
ipcMain.handle("workflow:backupStatus", () => workflowBackupStatus());
ipcMain.handle("workflow:backupOpen", () => {
  try {
    const dir = mk(WF_BACKUP_DIR());
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ---------------- IPC：数据库超级节点（SQLite/FTS5 事实库） ---------------- */
const dbStore = require("./db-store");

function dbStoreOpenFor(dir) {
  const s = String(dir || "");
  if (!s || !fs.existsSync(s) || !fs.statSync(s).isDirectory())
    throw new Error(I18n.t("数据库子文件夹不存在：") + s);
  return dbStore.openDb(dbStore.dbFilePath(s));
}
ipcMain.handle("db:compile", (e, { dir, records }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const changes = dbStore.compileRecords(db, records || []);
    return { ok: true, ...changes };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:list", (e, { dir }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const r = dbStore.dbList(db);
    return {
      ok: true,
      count: dbStore.dbCount(db),
      records: r.rows,
      sql: r.sql,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:query", (e, { dir, q, limit }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const h = dbStore.dbQuery(db, q, limit);
    return {
      ok: true,
      query: String(q || ""),
      found: h.rows.length,
      results: h.rows,
      sql: h.sql,
      ...(h.rows.length === 0
        ? { none: I18n.t("数据库中没有匹配该查询的记录") }
        : {}),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:get", (e, { dir, id }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const r = dbStore.dbGet(db, id);
    return r.record
      ? { ok: true, record: r.record, sql: r.sql }
      : { ok: false, error: I18n.t("数据库中没有该记录：") + String(id || "") };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:write", (e, { dir, records }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const r = dbStore.dbWrite(db, records || []);
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:delete", (e, { dir, ids }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    const r = dbStore.dbDelete(db, ids || []);
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});
ipcMain.handle("db:calc", (e, { expr }) => {
  const v = dbStore.dbCalcExpr(expr);
  return v === null
    ? { ok: false, error: I18n.t("calc 仅支持数字与 + - * / % 括号，表达式非法") }
    : { ok: true, expr: String(expr || ""), value: v };
});
ipcMain.handle("db:log", (e, { dir, entry }) => {
  let db = null;
  try {
    db = dbStoreOpenFor(dir);
    return { ok: true, log: dbStore.dbLogAppend(db, entry || {}) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (db) db.close();
  }
});

/* ---------------- 网络节点：节点级独立端口 + 通道(16bit) 分流 ---------------- */
/* 接收节点在各自端口上监听（同端口同协议的多个接收节点共享监听 socket，按通道号分流）；
   发送节点向 host:port 发起（默认本机，可填远程 IP）。监听端口与发送目标端口相互独立，
   默认 接收 40999 / 发送 41000。TCP/UDP 各自独立、异步互不干涉。 */
const NET_DEFAULT_PORT = 40999;

const netListeners = new Map(); // key "tcp:40999" -> {proto,port,ref,tcp,udp,err}

function netBroadcast(obj) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send("net:message", obj);
      } catch {}
    }
  }
}

/* 帧结构：2字节通道(BE) + 4字节负载长度(BE) + UTF-8 负载 */
function netEncodeFrame(channel, payload) {
  const body = Buffer.from(String(payload == null ? "" : payload), "utf8");
  const buf = Buffer.alloc(6 + body.length);
  buf.writeUInt16BE((Number(channel) || 0) & 0xffff, 0);
  buf.writeUInt32BE(body.length, 2);
  body.copy(buf, 6);
  return buf;
}

function netOpen(L) {
  try {
    if (L.proto === "tcp" && !L.tcp) {
      const net = require("net");
      L.tcp = net.createServer((sock) => {
        let acc = Buffer.alloc(0);
        sock.on("data", (d) => {
          acc = Buffer.concat([acc, d]);
          let idx = 0;
          while (idx + 6 <= acc.length) {
            const ch = acc.readUInt16BE(idx);
            const len = acc.readUInt32BE(idx + 2);
            const total = 6 + len;
            if (idx + total > acc.length) break;
            const body = acc.slice(idx + 6, idx + total).toString("utf8");
            idx += total;
            netBroadcast({ channel: ch, proto: "tcp", data: body, at: Date.now() });
          }
          acc = acc.slice(idx);
        });
      });
      L.tcp.on("error", (e) => (L.err = (e && e.message) || String(e)));
      L.tcp.listen(L.port, "0.0.0.0");
    } else if (L.proto === "udp" && !L.udp) {
      const dgram = require("dgram");
      L.udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
      L.udp.on("message", (msg) => {
        if (msg.length < 6) return;
        const ch = msg.readUInt16BE(0);
        const len = msg.readUInt32BE(2);
        const body = msg.slice(6, Math.min(6 + len, msg.length)).toString("utf8");
        netBroadcast({ channel: ch, proto: "udp", data: body, at: Date.now() });
      });
      L.udp.on("error", (e) => (L.err = (e && e.message) || String(e)));
      L.udp.bind(L.port, "0.0.0.0");
    }
  } catch (e) {
    L.err = (e && e.message) || String(e);
  }
}

function netClose(L) {
  try {
    if (L.tcp) {
      L.tcp.close();
      L.tcp = null;
    }
    if (L.udp) {
      L.udp.close();
      L.udp = null;
    }
  } catch {}
}

let netUdpSender = null;
ipcMain.handle("net:listen", (e, { port, channel, proto }) => {
  const p = Math.max(1, Math.min(65535, Number(port) || NET_DEFAULT_PORT));
  const key = (proto === "udp" ? "udp" : "tcp") + ":" + p;
  let L = netListeners.get(key);
  if (!L) {
    L = { proto: proto === "udp" ? "udp" : "tcp", port: p, ref: 0, tcp: null, udp: null, err: null };
    netListeners.set(key, L);
  }
  L.ref++;
  netOpen(L);
  return { ok: true, listenErr: L.err, port: p };
});
ipcMain.handle("net:unlisten", (e, { port, channel, proto }) => {
  const p = Math.max(1, Math.min(65535, Number(port) || NET_DEFAULT_PORT));
  const key = (proto === "udp" ? "udp" : "tcp") + ":" + p;
  const L = netListeners.get(key);
  if (!L) return { ok: true };
  L.ref = Math.max(0, L.ref - 1);
  if (L.ref <= 0) {
    netClose(L);
    netListeners.delete(key);
  }
  return { ok: true };
});
ipcMain.handle("net:send", (e, { host, port, channel, proto, data }) => {
  const h = String(host || "127.0.0.1");
  const p = Math.max(1, Math.min(65535, Number(port) || NET_DEFAULT_PORT));
  const ch = (Number(channel) || 0) & 0xffff;
  const frame = netEncodeFrame(ch, data);
  try {
    if (proto === "udp") {
      const dgram = require("dgram");
      if (!netUdpSender) netUdpSender = dgram.createSocket("udp4");
      netUdpSender.send(frame, 0, frame.length, p, h, (err) => {
        if (err) return;
      });
      return { ok: true };
    }
    const net = require("net");
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      const sock = net.createConnection({ host: h, port: p }, () => {
        try {
          sock.write(frame);
        } catch (err) {
          finish({ ok: false, error: (err && err.message) || String(err) });
        }
      });
      sock.setTimeout(4000, () => {
        sock.destroy();
        finish({ ok: false, error: I18n.t("发送超时") });
      });
      sock.on("error", (err) => finish({ ok: false, error: (err && err.message) || String(err) }));
      sock.on("close", () => finish({ ok: true }));
      sock.on("data", () => {}); /* 忽略响应，保持单向 */
    });
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* 打开 netdebug 调试工具（独立 Electron 工具，位于 ../netdebug），
   按网络节点参数（协议/目标/端口/通道）预填，实现画布 ↔ netdebug 打通。 */
ipcMain.handle("net:open-debug", (e, o = {}) => {
  try {
    const { spawn } = require("child_process");
    const cands = [
      process.env.NETDEBUG_DIR,
      path.join(__dirname, "..", "netdebug"),
      "E:\\dev\\tools\\netdebug",
    ].filter(Boolean);
    let dir = null;
    for (const c of cands) {
      try {
        if (c && fs.existsSync(path.join(c, "src", "main.js"))) {
          dir = c;
          break;
        }
      } catch (_) {}
    }
    if (!dir)
      return { ok: false, error: "未找到 netdebug 工具目录（可设环境变量 NETDEBUG_DIR）" };
    const args = [path.join(dir, "start.js")];
    const push = (k, v) => {
      if (v !== undefined && v !== null && v !== "") args.push("--" + k, String(v));
    };
    push("proto", o.proto);
    push("host", o.host);
    push("port", o.port);
    push("target-host", o.targetHost);
    push("target-port", o.targetPort);
    push("channel", o.channel);
    push("role", o.role);
    push("framed", o.framed === false ? "0" : "1");
    const child = spawn("node", args, {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, dir, args };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ---------------- IPC：资产 / 文件 ---------------- */

/* 参考图输入落盘 / 导入上限：长宽任一超过 1080px 时等比缩小（仅 asset:copy、画布包导入等参考用途）。
   生成输出走 asset:writeBase64，保持 API 返回的原尺寸。 */
const REF_IMAGE_MAX_DIM = 1080;
/* 发往 API 的参考图（vision / 图生图 edits）同样上限 1080p */
const API_REF_IMAGE_MAX_DIM = 1080;
/* 透明图差分抠图的锚定参考图（第 1 通道基准）：**不缩放**原尺寸下发。
   压到 1080 再要求模型按 2048 输出，等于让它把整张图放大重绘 —— 主体尺度必漂，
   两通道差分就在不一致处给出中间 Alpha，画面上是一整片虚影。
   只有体积大到可能撑爆接口时才兜底压一档，且像素上限仍远高于普通参考图。 */
const API_MATTE_REF_MAX_DIM = 2048;
const API_MATTE_REF_NATIVE_MAX_BYTES = 20 * 1024 * 1024;

/* 等比缩小图像缓冲；无法解码或已达标时原样返回。
   重编码：jpg/jpeg → JPEG(85)，其余超限时 → PNG。 */
function shrinkImageBuffer(raw, ext, maxDim) {
  const e0 = String(ext || "png")
    .toLowerCase()
    .replace(/^\./, "");
  let img;
  try {
    img = nativeImage.createFromBuffer(raw);
  } catch {
    return { buf: raw, ext: e0 || "png" };
  }
  if (!img || img.isEmpty()) return { buf: raw, ext: e0 || "png" };
  const { width: w, height: h } = img.getSize();
  if (!(w > maxDim || h > maxDim)) return { buf: raw, ext: e0 || "png" };
  const scale = Math.min(maxDim / w, maxDim / h);
  const resized = img.resize({
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  });
  const isJpeg = e0 === "jpg" || e0 === "jpeg";
  return {
    buf: isJpeg ? resized.toJPEG(85) : resized.toPNG(),
    ext: isJpeg ? (e0 === "jpg" ? "jpg" : "jpeg") : "png",
  };
}

function assetOutExt(srcExt, outExt) {
  const s = String(srcExt || "")
    .toLowerCase()
    .replace(/^\./, "");
  const o = String(outExt || "png")
    .toLowerCase()
    .replace(/^\./, "");
  if (o === "jpg" || o === "jpeg") {
    if (s === "jpg") return ".jpg";
    if (s === "jpeg") return ".jpeg";
    return ".jpg";
  }
  return "." + o;
}

ipcMain.handle("asset:copy", (e, { srcPath, wfId, name }) => {
  const src = String(srcPath || "");
  if (!src || !fs.existsSync(src)) {
    throw new Error("文件不存在: " + src);
  }
  const srcExt = path.extname(src).toLowerCase().replace(/^\./, "") || "png";
  const raw = fs.readFileSync(src);
  const { buf, ext } = shrinkImageBuffer(raw, srcExt, REF_IMAGE_MAX_DIM);
  const dest = join(
    assetDir(wfId),
    String(name).replace(/[^\w.-]/g, "_") + assetOutExt(srcExt, ext),
  );
  fs.writeFileSync(dest, buf);
  return { ok: true, path: dest };
});
ipcMain.handle("asset:writeBase64", (e, { wfId, name, base64, ext }) => {
  const srcExt = String(ext || "png").toLowerCase().replace(/^\./, "");
  const raw = Buffer.from(String(base64), "base64");
  const dest = join(
    assetDir(wfId),
    String(name).replace(/[^\w.-]/g, "_") + assetOutExt(srcExt, srcExt),
  );
  fs.writeFileSync(dest, raw);
  return { ok: true, path: dest };
});
ipcMain.handle("asset:readDataUrl", (e, p) => {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime =
    ext === "png"
      ? "image/png"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : "image/png";
  return {
    ok: true,
    dataUrl: "data:" + mime + ";base64," + buf.toString("base64"),
  };
});
/* 图像文件大小 + 像素尺寸（输入节点展示，便于估算视觉 token） */
ipcMain.handle("asset:meta", (e, p) => {
  try {
    const file = String(p || "");
    if (!file || !fs.existsSync(file)) return { ok: false };
    const st = fs.statSync(file);
    let width = 0,
      height = 0;
    try {
      const img = nativeImage.createFromPath(file);
      if (img && !img.isEmpty()) {
        const sz = img.getSize();
        width = sz.width || 0;
        height = sz.height || 0;
      }
    } catch (_) {}
    return { ok: true, bytes: st.size || 0, width, height };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("file:readText", (e, p) => {
  try {
    return { ok: true, exists: true, content: fs.readFileSync(p, "utf8") };
  } catch {
    return { ok: true, exists: false, content: "" };
  }
});
ipcMain.handle("file:writeText", (e, { path: p, content }) => {
  mk(path.dirname(p));
  fs.writeFileSync(p, content, "utf8");
  return { ok: true };
});
ipcMain.handle("file:writeBytes", (e, { path: p, data }) => {
  const dest = String(p || "");
  if (!dest) return { ok: false, error: I18n.t("未选择") };
  mk(path.dirname(dest));
  let buf;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) {
    buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (data && Array.isArray(data.data)) {
    buf = Buffer.from(data.data);
  } else {
    buf = Buffer.from(data || []);
  }
  fs.writeFileSync(dest, buf);
  return { ok: true };
});
ipcMain.handle("view:captureRect", async (e, rect) => {
  const w = win();
  if (!w || w.isDestroyed()) return { ok: false, error: I18n.t("未知错误") };
  const x = Math.round(Number(rect && rect.x) || 0);
  const y = Math.round(Number(rect && rect.y) || 0);
  const width = Math.max(1, Math.round(Number(rect && rect.width) || 0));
  const height = Math.max(1, Math.round(Number(rect && rect.height) || 0));
  try {
    const image = await w.webContents.capturePage({ x, y, width, height });
    const size = image.getSize();
    if (!size || !size.width || !size.height) {
      return { ok: false, error: I18n.t("生成总览图失败：") + "empty" };
    }
    return { ok: true, dataUrl: image.toDataURL() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("file:copyAssetTo", (e, { assetPath, destPath }) => {
  mk(path.dirname(destPath));
  fs.copyFileSync(assetPath, destPath);
  return { ok: true };
});
ipcMain.handle("file:exists", (e, p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});
ipcMain.handle("file:isDir", (e, p) => {
  try {
    const s = String(p || "");
    if (!s) return false;
    return fs.existsSync(s) && fs.statSync(s).isDirectory();
  } catch {
    return false;
  }
});
/* 单文件信息（数据库「文件节点」导入后取 size/mtime） */
ipcMain.handle("file:stat", (e, p) => {
  try {
    const st = fs.statSync(String(p || ""));
    return { ok: true, size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return { ok: false, error: I18n.t("路径不存在") };
  }
});
/* 目录列举（数据库节点编译索引）：递归返回文件 {name, rel, isDir, size, mtime}，跳过隐藏与重型目录 */
ipcMain.handle("file:listDir", (e, p) => {
  try {
    const s = String(p || "");
    if (!s) return { ok: true, list: [] };
    const out = [];
    const walk = (dir, base) => {
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        if (ent.name.startsWith(".")) continue;
        const full = join(dir, ent.name);
        const rel = base ? base + "/" + ent.name : ent.name;
        if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name === ".git") continue;
          if (out.length > 4000) return;
          walk(full, rel);
        } else {
          let size = 0,
            mtime = 0;
          try {
            const st = fs.statSync(full);
            size = st.size;
            mtime = st.mtimeMs;
          } catch {}
          out.push({ name: ent.name, rel, isDir: false, size, mtime });
          if (out.length > 4000) return;
        }
      }
    };
    if (fs.existsSync(s) && fs.statSync(s).isDirectory()) walk(s, "");
    return { ok: true, list: out };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle(
  "file:saveDialog",
  async (e, { title, defaultName, filters }) => {
    const r = await dialog.showSaveDialog(win(), {
      title: title || I18n.t("选择保存位置"),
      defaultPath: defaultName || "output.yaml",
      filters: filters || [{ name: I18n.t("全部文件"), extensions: ["*"] }],
    });
    return r.canceled ? { path: null } : { path: r.filePath };
  },
);
/* 导出文本:保存对话框 + 直接写盘(智能会话 /export 命令) */
ipcMain.handle("file:saveText", async (e, { name, content }) => {
  const r = await dialog.showSaveDialog(win(), {
    title: I18n.t("导出会话"),
    defaultPath: name || "session.txt",
    filters: [{ name: I18n.t("文本文件"), extensions: ["txt", "md"] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, error: I18n.t("已取消") };
  try {
    fs.writeFileSync(r.filePath, String(content || ""), "utf8");
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("file:openDialog", async (e, { title, filters, multi, directory }) => {
  const props = directory
    ? multi
      ? ["openDirectory", "multiSelections"]
      : ["openDirectory"]
    : multi
      ? ["openFile", "multiSelections"]
      : ["openFile"];
  const r = await dialog.showOpenDialog(win(), {
    title: title || (directory ? I18n.t("选择文件夹") : I18n.t("选择文件")),
    properties: props,
    filters: filters || [{ name: I18n.t("全部文件"), extensions: ["*"] }],
  });
  return r.canceled
    ? { path: null, paths: [] }
    : { path: r.filePaths[0] || null, paths: r.filePaths };
});
ipcMain.handle("shell:showItem", (e, p) => shell.showItemInFolder(p));
ipcMain.handle("shell:openPath", async (e, p) => {
  try {
    const dir = String(p || "").trim();
    if (!dir) return { ok: false, error: "empty path" };
    const err = await shell.openPath(dir);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 执行节点专用：独立进程启动绑定文件（win32: cmd /c start → 新控制台 + 新进程组，
   不随 MTNode 主程序退出而关闭；编译脚本的 console 不再被主程序退出带走）。
   仅执行节点使用；其它 shell:openPath 调用保持不变。 */
ipcMain.handle("shell:openPathDetached", async (e, p) => {
  try {
    const r = launchDetached(p);
    if (r && r.fallback === "shell-open") {
      const err = await shell.openPath(String(p || "").trim());
      return err ? { ok: false, error: err } : { ok: true };
    }
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 用系统默认浏览器打开外部链接（shell.openExternal → 系统默认浏览器），
   这里只做协议白名单（http/https/mailto），不加域名白名单、不做额外拦截；
   微信登录地址的域名口径（https + open.weixin.qq.com）在微信登录入口单独校验。 */
ipcMain.handle("shell:openExternal", (e, url) => {
  if (typeof url === "string" && /^(https?:\/\/|mailto:)/i.test(url))
    shell.openExternal(url);
});

/* ── 隐藏进程宿主（函数节点等运行期使用；执行节点不走这里，仍按自己的语义开新控制台）──
   与 shell:openPath / shell:openPathDetached 的区别：
   1) 一律 windowsHide + 非 detached + 管道 stdio —— 不弹控制台窗口、不共享 MTNode 的 console；
   2) 进程按 runId 记账，runId 与「函数节点的一次运行」一一对应 —— 运行结束/被停止即整棵进程树回收；
   3) 主窗销毁与应用退出两条兜底路径同样 killAll()，不留脱离运行的残留进程。 */
ipcMain.handle("proc:run", async (e, o = {}) => {
  try {
    return await procHost.startHidden(
      {
        cmd: o.cmd,
        args: o.args,
        cwd: o.cwd,
        env: o.env,
        runId: o.runId,
        shell: o.shell,
        label: o.label,
        wait: true,
      },
      { outputLimit: o.outputLimit },
    );
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 不等退出：只起进程 + 登记，进程随该 runId 统一回收（运行结束时由 proc:killRun 收走） */
ipcMain.handle("proc:spawn", async (e, o = {}) => {
  try {
    return await procHost.startHidden(
      {
        cmd: o.cmd,
        args: o.args,
        cwd: o.cwd,
        env: o.env,
        runId: o.runId,
        shell: o.shell,
        label: o.label,
        wait: false,
      },
      { outputLimit: o.outputLimit },
    );
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 回收一次运行的全部外部进程（含孙进程）；返回 { killed, pids } */
ipcMain.handle("proc:killRun", async (e, runId) => {
  try {
    return await procHost.killRun(runId);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle("proc:killAll", async () => {
  try {
    return await procHost.killAll();
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ── 函数节点运行时（函数节点 JS 的真正执行处）────────────────────────────
   一次函数节点运行 = 一个 worker 线程 + 一个 runId：
   1) 用户 JS 在主进程的独立线程里跑 —— 渲染进程主线程不再被同步代码占住，
      界面照常重绘可点、「运行中」刷得出来，也随时能硬终止；
   2) 代码里的 mtnode.exec / mtnode.spawn 一律走上面的隐藏进程宿主：隐藏启动、
      不弹控制台窗口，并绑到本次 runId；
   3) 运行结束 / 被停止 / 超时：立刻 worker.terminate() + 按 runId 回收整棵进程树，
      返回结果的 killedProcs 就是本次回收掉的外部进程数
      —— 节点不在运行态 ⇒ 它绑定的线程与进程不存在。
   事件帧（log / progress / end）经 fn:event 推回发起的渲染进程。 */
let fnRuntime = null;
function fnRuntimeOf() {
  if (!fnRuntime) fnRuntime = createFnRuntime({ appRoot: __dirname, procHost });
  return fnRuntime;
}
ipcMain.handle("fn:run", async (e, o = {}) => {
  const runId = String((o && o.runId) || "");
  const emit =
    e && e.sender
      ? (frame) => {
          try {
            if (!e.sender.isDestroyed()) e.sender.send("fn:event", frame);
          } catch {}
        }
      : null;
  try {
    return await fnRuntimeOf().run(o, emit);
  } catch (err) {
    return {
      ok: false,
      value: undefined,
      error: (err && err.message) || String(err),
      runId,
      killedProcs: 0,
      killedPids: [],
    };
  }
});
/* 停止一次运行：终止线程 + 回收其全部外部进程（返回同一形状的收尾结果） */
ipcMain.handle("fn:cancel", async (e, o) => {
  try {
    return await fnRuntimeOf().cancel(o);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
/* 观测：当前还有几个函数运行活着（排查「进程是否已回收」用） */
ipcMain.handle("fn:active", async () => {
  try {
    const r = fnRuntimeOf();
    return { ok: true, count: r.activeCount(), runs: r.listActive() };
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || String(err),
      count: 0,
      runs: [],
    };
  }
});

/* 应用内嵌套对话框打开链接/文件（modal + parent），关闭后回到主窗，避免主窗被导航走 */
let contentViewWin = null;
const CONTENT_VIEW_EXTERNAL_EXT = new Set([
  ".exe",
  ".msi",
  ".bat",
  ".cmd",
  ".ps1",
  ".lnk",
  ".com",
  ".app",
  ".dmg",
]);

function closeContentViewWin() {
  if (contentViewWin && !contentViewWin.isDestroyed()) {
    try {
      contentViewWin.close();
    } catch {}
  }
  contentViewWin = null;
}

function openContentViewDialog(opts) {
  const parent = opts && opts.parent;
  const targetUrl = String((opts && opts.url) || "").trim();
  if (!parent || parent.isDestroyed())
    return { ok: false, error: "no parent window" };
  if (!targetUrl) return { ok: false, error: "empty url" };

  closeContentViewWin();

  let width = 960;
  let height = 720;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    width = Math.min(1100, Math.max(640, Math.round(wa.width * 0.82)));
    height = Math.min(820, Math.max(480, Math.round(wa.height * 0.82)));
  } catch {}

  contentViewWin = new BrowserWindow({
    width,
    height,
    parent,
    modal: true,
    show: false,
    title: String((opts && opts.title) || I18n.t("预览") || "预览"),
    autoHideMenuBar: true,
    backgroundColor: "#0d1016",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  contentViewWin.setMenu(null);
  contentViewWin.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || "");
    if (/^https?:\/\//i.test(u) && contentViewWin && !contentViewWin.isDestroyed()) {
      contentViewWin.loadURL(u).catch(() => {});
    }
    return { action: "deny" };
  });
  contentViewWin.on("closed", () => {
    contentViewWin = null;
  });
  contentViewWin.once("ready-to-show", () => {
    if (contentViewWin && !contentViewWin.isDestroyed()) contentViewWin.show();
  });
  contentViewWin.loadURL(targetUrl).catch(() => {});
  return { ok: true, dialog: true };
}

ipcMain.handle("shell:openInAppDialog", async (e, opts) => {
  opts = opts || {};
  const parent = BrowserWindow.fromWebContents(e.sender) || mainWin;
  const kind = String(opts.kind || "").trim();
  let target = String(opts.target || "").trim();
  if (!target) return { ok: false, error: "empty" };

  if (kind === "url" || /^https?:\/\//i.test(target)) {
    if (!/^https?:\/\//i.test(target))
      return { ok: false, error: "unsupported url" };
    return openContentViewDialog({
      parent,
      url: target,
      title: target,
    });
  }

  if (kind === "mailto" || /^mailto:/i.test(target)) {
    if (/^mailto:/i.test(target)) shell.openExternal(target);
    return { ok: true, external: true };
  }

  if (/^file:/i.test(target)) {
    try {
      let s = target.replace(/^file:\/\//i, "");
      if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
      target = decodeURIComponent(s);
    } catch {
      return { ok: false, error: "bad file url" };
    }
  }

  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    return { ok: false, error: (err && err.message) || "not found" };
  }

  if (st.isDirectory()) {
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true, external: true };
  }

  const ext = path.extname(target).toLowerCase();
  if (CONTENT_VIEW_EXTERNAL_EXT.has(ext)) {
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true, external: true };
  }

  /* YAML：交给渲染进程内嵌阅读器（MTNode 主题大窗），不走 file:// 裸开 */
  if (ext === ".yaml" || ext === ".yml") {
    try {
      if (parent && !parent.isDestroyed()) {
        parent.webContents.send("yaml-viewer:open", {
          path: path.resolve(target),
        });
        return { ok: true, yamlViewer: true };
      }
    } catch {}
  }

  /* Markdown：交给渲染进程内嵌阅读器（查看 / 编辑 / 保存），不走 file:// 裸开 */
  if (ext === ".md" || ext === ".markdown" || ext === ".mdown") {
    try {
      if (parent && !parent.isDestroyed()) {
        parent.webContents.send("md-viewer:open", {
          path: path.resolve(target),
        });
        return { ok: true, mdViewer: true };
      }
    } catch {}
  }

  return openContentViewDialog({
    parent,
    url: pathToFileURL(path.resolve(target)).href,
    title: path.basename(target),
  });
});
ipcMain.handle("clipboard:readText", () => clipboard.readText());

/* ---------------- 画布导出/导入（.mtnodes 二进制包） ----------------
   .mtnodes 容器 = 7 字节魔数 "MTNODES" + 1 字节版本 + 4 字节清单长度 +
   gzip(清单 JSON) + 4 字节资产数 + 逐资产 [4 字节名长 + 名 + 4 字节数据长 + 数据]。
   清单 JSON = { format, version, app, exportedAt, workflowName, workflow, assets }；
   workflow 内所有指向应用数据目录的资产绝对路径被替换为 "@asset/<i>" 占位，
   导入时按 assets 顺序写回并重映射为新工作流下的绝对路径。 */

const MTNODES_MAGIC = "MTNODES";
const MTNODES_VERSION = 1;

/* 深拷贝遍历所有字符串值：fn 返回替换后的字符串（未变化原样返回） */
function mapStrings(v, fn) {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = mapStrings(v[k], fn);
    return out;
  }
  return v;
}

/* 只读遍历所有字符串值 */
function walkStrings(v, fn) {
  if (typeof v === "string") {
    fn(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walkStrings(x, fn);
    return;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) walkStrings(v[k], fn);
  }
}

/* 是否可打包的资产：应用数据目录下真实存在的文件（不打包用户自选的外部输出路径） */
function isBundlablePath(p) {
  if (typeof p !== "string" || !p || !path.isAbsolute(p)) return false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  const rel = path.relative(DATA(), p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/* 收集工作流中引用的全部资产绝对路径（去重、保序） */
function collectAssetPaths(wf) {
  const seen = new Set();
  const paths = [];
  walkStrings(wf, (s) => {
    if (seen.has(s) || !isBundlablePath(s)) return;
    seen.add(s);
    paths.push(s);
  });
  return paths;
}

function sanitizeBase(name) {
  const s = String(name || "asset").replace(/[^\w.-]/g, "_");
  return s || "asset";
}

function packMtNodes(wf) {
  const clone = JSON.parse(JSON.stringify(wf || {}));
  const paths = collectAssetPaths(clone);
  const map = new Map();
  const files = [];
  paths.forEach((p, i) => {
    const key = "@asset/" + i;
    map.set(p, key);
    files.push({ name: path.basename(p), rel: path.relative(DATA(), p), bytes: fs.readFileSync(p) });
  });
  const workflow = mapStrings(clone, (s) => map.get(s) || s);
  const manifest = {
    format: "mtnodes",
    version: MTNODES_VERSION,
    app: "MTNode",
    exportedAt: new Date().toISOString(),
    workflowName: workflow.name || "",
    workflow,
    assets: files.map((f, i) => ({ key: "@asset/" + i, name: f.name, rel: f.rel })),
  };
  const manifestBuf = zlib.gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(manifestBuf.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(files.length, 0);
  const chunks = [Buffer.from(MTNODES_MAGIC, "ascii"), Buffer.from([MTNODES_VERSION]), head, manifestBuf, count];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const nl = Buffer.alloc(4);
    nl.writeUInt32LE(nameBuf.length, 0);
    const dl = Buffer.alloc(4);
    dl.writeUInt32LE(f.bytes.length, 0);
    chunks.push(nl, nameBuf, dl, f.bytes);
  }
  return { buf: Buffer.concat(chunks), assetCount: files.length };
}

/* 导入落盘：把容器里的资产写回新工作流目录，并把 "@asset/<i>" 占位重映射为新绝对路径 */
function materializeImport(manifest, files) {
  const wf = manifest.workflow || {};
  const newId = "imp_" + Date.now().toString(36);
  const dir = assetDir(newId);
  const used = new Set();
  const map = new Map();
  for (let i = 0; i < files.length; i++) {
    const asset = manifest.assets && manifest.assets[i];
    const key = asset && asset.key ? asset.key : "@asset/" + i;
    let name = sanitizeBase(files[i].name || ("asset" + i));
    let dest = path.join(dir, name);
    let k = 1;
    while (used.has(dest.toLowerCase())) {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      dest = path.join(dir, base + "_" + k + ext);
      k++;
    }
    used.add(dest.toLowerCase());
    const srcExt = path.extname(dest).toLowerCase().replace(/^\./, "") || "png";
    const shrunk = shrinkImageBuffer(files[i].data, srcExt, REF_IMAGE_MAX_DIM);
    let outDest = dest;
    const wantExt = assetOutExt(srcExt, shrunk.ext);
    if (path.extname(dest).toLowerCase() !== wantExt) {
      outDest = dest.slice(0, dest.length - path.extname(dest).length) + wantExt;
      used.delete(dest.toLowerCase());
      used.add(outDest.toLowerCase());
    }
    fs.writeFileSync(outDest, shrunk.buf);
    map.set(key, outDest);
  }
  const workflow = mapStrings(wf, (s) => map.get(s) || s);
  workflow.id = newId;
  return workflow;
}

function unpackMtNodes(buf) {
  if (buf.length < 8) throw new Error(I18n.t("文件太小，不是有效的画布包"));
  const magic = buf.slice(0, 7).toString("ascii");
  if (magic !== MTNODES_MAGIC) throw new Error(I18n.t("不是有效的 .mtnodes 画布文件"));
  const version = buf[7];
  if (version !== MTNODES_VERSION) throw new Error(I18n.t("不支持的画布包版本：") + version);
  let off = 8;
  const ml = buf.readUInt32LE(off);
  off += 4;
  if (off + ml > buf.length) throw new Error(I18n.t("画布包已损坏（清单越界）"));
  const manifest = JSON.parse(zlib.gunzipSync(buf.slice(off, off + ml)).toString("utf8"));
  off += ml;
  const fc = buf.readUInt32LE(off);
  off += 4;
  const files = [];
  for (let i = 0; i < fc; i++) {
    const nl = buf.readUInt32LE(off);
    off += 4;
    const name = buf.slice(off, off + nl).toString("utf8");
    off += nl;
    const dl = buf.readUInt32LE(off);
    off += 4;
    const data = buf.slice(off, off + dl);
    off += dl;
    files.push({ name, data });
  }
  if (manifest.format !== "mtnodes") throw new Error(I18n.t("不是有效的 .mtnodes 画布文件"));
  return { manifest, files };
}

/* 模板上传：去掉本机工作目录，避免把路径泄漏给下载方 */
function stripWorkspacesFromWf(wf) {
  if (!wf || typeof wf !== "object") return wf;
  if (typeof wf.workspace === "string") wf.workspace = "";
  for (const n of wf.nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.workspace === "string") n.workspace = "";
    if (typeof n.agentWorkspace === "string") n.agentWorkspace = "";
  }
  return wf;
}

function stripWorkspaceFromMtNodesBuf(buf) {
  const { manifest, files } = unpackMtNodes(buf);
  stripWorkspacesFromWf(manifest.workflow);
  const workflow = manifest.workflow || {};
  const assets = [];
  for (let i = 0; i < files.length; i++) {
    const a = (manifest.assets && manifest.assets[i]) || {};
    assets.push({
      key: a.key || "@asset/" + i,
      name: a.name || files[i].name || "asset" + i,
      rel: a.rel || "",
    });
  }
  const outManifest = {
    format: "mtnodes",
    version: MTNODES_VERSION,
    app: "MTNode",
    exportedAt: new Date().toISOString(),
    workflowName: workflow.name || "",
    workflow,
    assets,
  };
  const manifestBuf = zlib.gzipSync(
    Buffer.from(JSON.stringify(outManifest), "utf8"),
  );
  const head = Buffer.alloc(4);
  head.writeUInt32LE(manifestBuf.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(files.length, 0);
  const chunks = [
    Buffer.from(MTNODES_MAGIC, "ascii"),
    Buffer.from([MTNODES_VERSION]),
    head,
    manifestBuf,
    count,
  ];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name || "asset", "utf8");
    const nl = Buffer.alloc(4);
    nl.writeUInt32LE(nameBuf.length, 0);
    const dl = Buffer.alloc(4);
    dl.writeUInt32LE(f.data.length, 0);
    chunks.push(nl, nameBuf, dl, f.data);
  }
  return { buf: Buffer.concat(chunks), assetCount: files.length };
}

ipcMain.handle("mtnodes:stripWorkspaceBase64", (e, base64) => {
  try {
    const raw = Buffer.from(String(base64 || ""), "base64");
    const { buf, assetCount } = stripWorkspaceFromMtNodesBuf(raw);
    return {
      ok: true,
      base64: buf.toString("base64"),
      bytes: buf.length,
      assetCount,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("mtnodes:export", async (e, wf) => {
  try {
    const { buf } = packMtNodes(wf);
    const r = await dialog.showSaveDialog(win(), {
      title: I18n.t("导出画布"),
      defaultPath: sanitizeBase((wf && wf.name) || "workflow") + ".mtnodes",
      filters: [{ name: I18n.t("MTNode 画布"), extensions: ["mtnodes"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, error: I18n.t("已取消") };
    fs.writeFileSync(r.filePath, buf);
    return { ok: true, path: r.filePath, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("mtnodes:import", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("导入画布"),
      properties: ["openFile"],
      filters: [{ name: I18n.t("MTNode 画布"), extensions: ["mtnodes"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: I18n.t("已取消") };
    const { manifest, files } = unpackMtNodes(fs.readFileSync(r.filePaths[0]));
    return { ok: true, workflow: materializeImport(manifest, files) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("mtnodes:exportBase64", (e, wf) => {
  try {
    const { buf, assetCount } = packMtNodes(wf);
    return { ok: true, base64: buf.toString("base64"), bytes: buf.length, assets: assetCount };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("mtnodes:importBase64", (e, base64) => {
  try {
    if (typeof base64 !== "string" || !base64.trim()) return { ok: false, error: I18n.t("Base64 内容为空") };
    const buf = Buffer.from(base64.trim(), "base64");
    if (!buf.length) return { ok: false, error: I18n.t("Base64 解码失败") };
    const { manifest, files } = unpackMtNodes(buf);
    return { ok: true, workflow: materializeImport(manifest, files) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* 只解析清单中的工作流结构（不落盘资产），供模板商店节点预览 */
ipcMain.handle("mtnodes:peekBase64", (e, base64) => {
  try {
    if (typeof base64 !== "string" || !base64.trim()) return { ok: false, error: I18n.t("Base64 内容为空") };
    const buf = Buffer.from(base64.trim(), "base64");
    if (!buf.length) return { ok: false, error: I18n.t("Base64 解码失败") };
    const { manifest } = unpackMtNodes(buf);
    const wf = manifest && manifest.workflow;
    if (!wf || typeof wf !== "object") return { ok: false, error: I18n.t("不是有效的 .mtnodes 画布文件") };
    return {
      ok: true,
      workflow: JSON.parse(JSON.stringify(wf)),
      name: (manifest && manifest.workflowName) || (wf && wf.name) || "",
      assets: ((manifest && manifest.assets) || []).length,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("clipboard:writeText", (e, text) => {
  try {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* ---------------- 团队事实库：插图与无引用图片回收 ----------------
   事实库正文是磁盘上的 Markdown，插图复制进它的 assets 目录、正文用相对路径引用。
   fact:saveImage 支持「本机文件路径」或「base64（剪贴板 / 截图）」，文件名做安全化 + 唯一化；
   被写过的目录登记进白名单（持久化到 userData），fact:deleteImages 只删白名单目录内的文件，
   渲染层即使传入任意路径也删不掉目录外的东西（防越权）。 */
/* 应用目录（asar 根 + 安装目录）：事实库**绝不允许**落在这里 —— 升级 / 卸载会带走或覆盖。
   app.getAppPath() = 打包态的 resources/app.asar（开发态 = 项目根）；
   path.dirname(app.getPath("exe")) = 安装目录（NSIS 卸载会清空）。两者都交给渲染层做同口径守卫。 */
const APP_DIRS = (() => {
  const out = [];
  const push = (p) => {
    try {
      const a = path.resolve(String(p || ""));
      if (a && !out.includes(a)) out.push(a);
    } catch {}
  };
  try { push(app.getAppPath()); } catch {}
  try { push(path.dirname(app.getPath("exe"))); } catch {}
  return out;
})();
/* 目标路径是否位于应用目录内（本目录或它的子路径）；Windows 大小写不敏感。 */
function isInsideAppDir(p) {
  const target = path.resolve(String(p || ""));
  if (!target) return false;
  const cmp = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const t = cmp(target);
  return APP_DIRS.some((d) => {
    const base = cmp(d);
    return !!base && (t === base || t.startsWith(base + path.sep));
  });
}

/* ---------------- 应用目录零数据：启动体检（只读） ----------------
   「任何数据都不允许保存在应用文件夹」。启动时体检一次：数据目录、事实库、
   save / save-backups、日志、素材库等解析结果若**等于或位于** app.getAppPath()
   （打包后 = resources/app.asar，开发态 = 项目根）或 exe 同目录之下，就记日志并
   弹窗报警 —— 绝不静默写入，也绝不自动搬迁（数据搬家必须由用户显式执行）。 */
function appDirDataCandidates() {
  const out = [];
  const add = (label, p) => {
    const s = String(p || "").trim();
    if (s && path.isAbsolute(s)) out.push({ label: label, path: path.resolve(s) });
  };
  let dataRoot = "";
  try { dataRoot = DATA(); } catch {}
  if (dataRoot) {
    add("数据目录", dataRoot);
    const subs = [
      ["工作流存档 save", "save"],
      ["画布备份 save-backups", "save-backups"],
      ["画布图像/媒体资产 assets", "assets"],
      ["日志 logs", "logs"],
      ["崩溃报告 logs/crash-reports", path.join("logs", "crash-reports")],
      ["回收站 trash", "trash"],
      ["讨论区缓存 forum", "forum"],
      ["工坊缓存 store-cache", "store-cache"],
      ["工作流 workflows", "workflows"],
      ["dsh 工作区 dsh-workspace", "dsh-workspace"],
      ["运行日志 dsh.log", "dsh.log"],
      ["错误日志 error.log", "error.log"],
    ];
    for (const [label, sub] of subs) add(label, path.join(dataRoot, sub));
  }
  let cfg = {};
  try { cfg = readJson(path.join(dataRoot || "", "config.json"), {}) || {}; } catch {}
  /* 素材库：config.assetRoot，未配置时回落数据目录下 asset-lib */
  try {
    const ar = typeof cfg.assetRoot === "string" ? cfg.assetRoot.trim() : "";
    add("素材库", ar || (dataRoot ? path.join(dataRoot, "asset-lib") : ""));
  } catch {}
  /* 团队事实库：每画布的 fact.dir / fact.assetsDir */
  try {
    const cans = cfg.team && Array.isArray(cfg.team.canvases) ? cfg.team.canvases : [];
    for (const c of cans) {
      const f = (c && c.fact) || {};
      const id = (c && c.id) || "?";
      add("团队事实库(" + id + ")", f.dir);
      add("团队事实库插图(" + id + ")", f.assetsDir);
    }
  } catch {}
  return out;
}

function auditAppDirData() {
  const hits = appDirDataCandidates().filter((x) => isInsideAppDir(x.path));
  if (!app.isPackaged) {
    console.log(
      "[appdir-audit] 开发态体检：数据目录 " + DATA() + "，" +
        (hits.length
          ? "发现 " + hits.length + " 处数据落在应用目录内（见下方告警）"
          : "未发现数据落在应用目录内"),
    );
  }
  if (!hits.length) return;
  const items = hits.map((h) => "· " + h.label + "\n    " + h.path).join("\n");
  const detail =
    "下列数据保存在应用文件夹内，升级 / 卸载会带走或覆盖它们：\n\n" +
    items +
    "\n\n请把这些数据移到项目文件夹（如 <项目文件夹>\\团队事实库），改完后重启应用。";
  console.warn("[appdir-audit] 检测到 " + hits.length + " 处数据位于应用目录内：");
  for (const h of hits) console.warn("[appdir-audit]   " + h.label + " → " + h.path);
  /* 记日志：仅当数据目录本身不在应用目录内才写，避免体检自己又往应用目录写数据 */
  try {
    if (!isInsideAppDir(DATA())) {
      const d = path.join(DATA(), "logs");
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(
        path.join(d, "error.log"),
        "[" + new Date().toISOString() + "] [appdir-audit] " +
          hits.map((h) => h.label + "=" + h.path).join(" | ") + "\n",
      );
    }
  } catch {}
  try {
    const opts = {
      type: "warning",
      title: "数据保存在应用文件夹内",
      message: "检测到 " + hits.length + " 处数据位于应用文件夹内",
      detail: detail,
      buttons: ["知道了"],
    };
    const parent = mainWin && !mainWin.isDestroyed() ? mainWin : null;
    const p = parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
    Promise.resolve(p).catch(() => {});
  } catch {}
}

const FACT_DIRS_FILE = path.join(APP_DATA_ROOT, "fact-asset-dirs.json");
function factLoadAssetDirs() {
  try {
    const j = JSON.parse(fs.readFileSync(FACT_DIRS_FILE, "utf8"));
    return new Set(
      (Array.isArray(j) ? j : [])
        .map((x) => String(x || "").trim())
        .filter((x) => x && path.isAbsolute(x))
        .map((x) => path.resolve(x)),
    );
  } catch {
    return new Set();
  }
}
const FACT_ASSET_DIRS = factLoadAssetDirs();
function factRememberDir(dir) {
  const d = path.resolve(dir);
  if (FACT_ASSET_DIRS.has(d)) return;
  FACT_ASSET_DIRS.add(d);
  try {
    writeJson(FACT_DIRS_FILE, Array.from(FACT_ASSET_DIRS));
  } catch {}
}
/* base64 可能带 data URL 前缀（data:image/png;base64,...），统一剥掉。 */
function factStripDataUrl(s) {
  const t = String(s || "");
  const i = t.indexOf("base64,");
  return i >= 0 ? t.slice(i + 7) : t;
}
function factExtOf(o, srcPath) {
  let ext = String((o && o.ext) || "").trim().toLowerCase();
  if (ext && ext[0] !== ".") ext = "." + ext;
  if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = "";
  if (!ext) {
    const m = /^data:image\/([a-z0-9.+-]+)/i.exec(String((o && o.base64) || ""));
    if (m) ext = "." + m[1].toLowerCase().replace(/^jpeg$/, "jpg");
  }
  if (!ext && srcPath) ext = path.extname(String(srcPath)).toLowerCase();
  if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = ".png";
  return ext;
}
function factSafeBase(name) {
  const s = path
    .basename(String(name || ""))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[.\s]+$/, "")
    .trim();
  return s || "image";
}
function factUniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  let i = 1;
  while (fs.existsSync(p) && i <= 9999) {
    p = path.join(dir, base + "-" + i + ext);
    i += 1;
  }
  if (fs.existsSync(p))
    p = path.join(dir, base + "-" + Date.now().toString(36) + ext);
  return p;
}

/* 剪贴板 / 截图取图 → PNG base64（渲染层再决定落盘位置）。 */
ipcMain.handle("clipboard:readImage", () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false, empty: true };
    const size = img.getSize();
    return {
      ok: true,
      base64: img.toPNG().toString("base64"),
      width: (size && size.width) || 0,
      height: (size && size.height) || 0,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("fact:saveImage", (e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const dirRaw = String(o.dir || "").trim();
    if (!dirRaw || !path.isAbsolute(dirRaw))
      return { ok: false, error: I18n.t("未选择") };
    const dir = path.resolve(dirRaw);
    if (dir === path.parse(dir).root) return { ok: false, error: I18n.t("非法路径") };
    const srcPath = String(o.srcPath || "").trim();
    if (!srcPath && !String(o.base64 || "").trim())
      return { ok: false, error: I18n.t("未选择") };
    mk(dir);
    const dest = factUniquePath(dir, factSafeBase(o.name || "image"), factExtOf(o, srcPath));
    if (srcPath) fs.copyFileSync(srcPath, dest);
    else fs.writeFileSync(dest, Buffer.from(factStripDataUrl(o.base64), "base64"));
    factRememberDir(dir);
    return { ok: true, path: dest, name: path.basename(dest), dir };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 只删白名单（事实库 assets）目录内的文件；目录外的路径一律 skipped，不落手。 */
ipcMain.handle("fact:deleteImages", (e, opts) => {
  const list = Array.isArray(opts && opts.paths) ? opts.paths : [];
  const removed = [];
  const skipped = [];
  const failed = [];
  for (const raw of list) {
    try {
      const s = String(raw || "").trim();
      if (!s) continue;
      const abs = path.resolve(s);
      if (!FACT_ASSET_DIRS.has(path.dirname(abs))) {
        skipped.push(abs);
        continue;
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) fs.unlinkSync(abs);
      removed.push(abs);
    } catch {
      failed.push(String(raw || ""));
    }
  }
  return { ok: true, removed, skipped, failed };
});

/* 事实库重命名 / 删除：**按单篇文档**作用（<doc>.md 正文 + <doc>.review.json sidecar），
   同一库目录内的其它文档与共享 assets/ 不受影响。路径守卫与 fact:deleteImages 同源：
   只认绝对路径、非磁盘根，且目录必须长得像事实库（名为「团队事实库」或已登记进
   FACT_ASSET_DIRS），**且不在应用目录内**，防越权动任意文件、也防库落在会被升级覆盖的地方。
   注：旧口径里的 `facts/<id>/`（应用数据目录回退）已取消，不再算合法库目录。 */
function factLibDirOf(file) {
  const f = path.resolve(String(file || "").trim());
  if (!f || f === path.parse(f).root) return "";
  if (path.extname(f).toLowerCase() !== ".md") return "";
  const dir = path.dirname(f);
  if (!path.isAbsolute(dir) || dir === path.parse(dir).root) return "";
  if (isInsideAppDir(dir)) return "";
  const base = path.basename(dir);
  if (
    base === "团队事实库" ||
    FACT_ASSET_DIRS.has(dir) ||
    FACT_ASSET_DIRS.has(path.join(dir, "assets"))
  )
    return dir;
  return "";
}

/* 重命名单篇文档：只改这一篇的 <doc>.md 与 <doc>.review.json，库内其它文档与 assets/ 不动。 */
ipcMain.handle("fact:renameLibrary", (e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const dir = factLibDirOf(o.file);
    if (!dir) return { ok: false, error: I18n.t("非法路径") };
    const name = factSafeBase(o.name || "");
    if (!name) return { ok: false, error: I18n.t("未选择") };
    const oldFile = path.resolve(String(o.file));
    const newFile = path.join(dir, name + ".md");
    const oldBase = path.basename(oldFile, path.extname(oldFile));
    const oldRv = path.join(dir, oldBase + ".review.json");
    const newRv = path.join(dir, name + ".review.json");
    const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    /* 目标名与源文件不同时，先确认没被库内其它文档占用（md 或 sidecar 都算），
       绝不覆盖别的文档；仅改大小写视为同一文件，照常执行。 */
    if (key(newFile) !== key(oldFile)) {
      if (fs.existsSync(newFile) || fs.existsSync(newRv))
        return { ok: false, error: I18n.t("同名文件已存在") };
    }
    if (newFile !== oldFile) fs.renameSync(oldFile, newFile);
    if (key(oldRv) !== key(newRv) && fs.existsSync(oldRv)) fs.renameSync(oldRv, newRv);
    return { ok: true, file: newFile, name };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 删单篇文档：只删这一篇的 md + sidecar；共享 assets/ 与空目录仅当库内再无其它文档时回收。 */
ipcMain.handle("fact:removeLibrary", (e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const dir = factLibDirOf(o.file);
    if (!dir) return { ok: false, error: I18n.t("非法路径") };
    const removed = [];
    const file = path.resolve(String(o.file));
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed.push(file);
    }
    const rv = path.join(dir, path.basename(file, path.extname(file)) + ".review.json");
    if (fs.existsSync(rv)) {
      fs.unlinkSync(rv);
      removed.push(rv);
    }
    /* 库内还有别的文档（.md / .review.json）→ 保留共享 assets/ 与目录，绝不误删。 */
    let others = [];
    try {
      others = fs.readdirSync(dir).filter((n) => {
        const low = String(n).toLowerCase();
        return low.endsWith(".md") || low.endsWith(".review.json");
      });
    } catch {
      others = [];
    }
    if (!others.length) {
      const assets = path.join(dir, "assets");
      if (fs.existsSync(assets) && fs.statSync(assets).isDirectory()) {
        fs.rmSync(assets, { recursive: true, force: true });
        removed.push(assets);
      }
      try {
        if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
      } catch {}
    }
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 整库搬迁（历史错位修复）：把整个「团队事实库」目录从 from 搬到 to —— 用于把旧版跟着
   开发画布项目根、误建在应用文件夹里的库迁回画布文件夹（渲染层 relocateLibrary 发起，用户已确认）。
   守卫与建库同口径但**方向相反**：from 只认「目录名 = 团队事实库」的绝对路径（它可能正位于
   应用目录内 —— 那正是要搬出去的原因，所以这里不做应用目录拒绝）；to 必须同名、绝对、
   **不在应用目录内**、且**不存在**（不合并、不覆盖，避免误伤别的库）。
   优先 rename（原子零拷贝）；跨卷 EXDEV 退化 copy + 指纹校验通过后再删源。 */
ipcMain.handle("fact:relocateLibrary", (e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const fromRaw = String(o.from || "").trim();
    const toRaw = String(o.to || "").trim();
    if (!fromRaw || !toRaw) return { ok: false, error: I18n.t("未选择") };
    if (!path.isAbsolute(fromRaw) || !path.isAbsolute(toRaw))
      return { ok: false, error: I18n.t("请选择绝对路径") };
    const from = path.resolve(fromRaw);
    const to = path.resolve(toRaw);
    if (from === path.parse(from).root || to === path.parse(to).root)
      return { ok: false, error: I18n.t("非法路径") };
    if (path.basename(from) !== "团队事实库" || path.basename(to) !== "团队事实库")
      return { ok: false, error: I18n.t("非法路径") };
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory())
      return { ok: false, error: I18n.t("路径不存在") };
    if (isInsideAppDir(to))
      return { ok: false, error: I18n.t("事实库目录不能落在应用目录内") };
    if (from === to) return { ok: true, moved: false };
    if (fs.existsSync(to)) return { ok: false, error: I18n.t("同名文件已存在") };
    mk(path.dirname(to));
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if (!err || err.code !== "EXDEV")
        return { ok: false, error: String((err && err.message) || err) };
      const before = diskFootprint(from);
      fs.cpSync(from, to, { recursive: true, dereference: true });
      const after = diskFootprint(to);
      if (before.files !== after.files || before.bytes !== after.bytes)
        return { ok: false, copied: true, error: I18n.t("复制校验不一致，事实库未迁移") };
      try {
        fs.rmSync(from, { recursive: true, force: true });
      } catch (err2) {
        return {
          ok: true,
          moved: true,
          sourceKept: true,
          error: String((err2 && err2.message) || err2),
        };
      }
    }
    /* 新库的 assets 目录进白名单：迁完即可继续插图 / 跑孤立图片回收。 */
    try {
      factRememberDir(path.join(to, "assets"));
    } catch {}
    return { ok: true, moved: true, from, to };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 在线浏览:主进程代取远程内容(无 CORS/CSP 限制;渲染层 connect-src 保持 'self') */
ipcMain.handle("net:fetch", async (e, url) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return { ok: false, error: I18n.t("非法 URL") };
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MTNodeAIO/1.1" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 模板商店 SaaS（经本机 nginx /mtnode/store-api 反代到 127.0.0.1:8787） */
const STORE_BASE =
  process.env.MTNODE_STORE_URL || "https://www.mt-agent.com/mtnode/store-api";

/* 账户凭据本机存储：safeStorage 加密后原子写入 %APPDATA%\pipeline-console，
   不可用时降级明文并告警；token 只留主进程，绝不回传渲染层。 */
const { createAuthStore } = require("./auth-store.js");
const authStore = createAuthStore({
  dataDir: APP_DATA_ROOT,
  safeStorage,
  onWarn: (msg) => errLog("[auth] " + msg),
});

function notifyAuthChanged() {
  const st = authStore.state();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send("auth:changed", st);
    } catch {}
  }
}

/* 一次性迁移：旧版把商店 / 论坛会话存在 config.json 的 storeAuth 里（含明文 token），
   现在统一由 auth-store 保管。首次读到旧值即迁入并清空旧字段，避免两份 token 打架。 */
function migrateLegacyStoreAuth() {
  try {
    const fp = join(DATA(), "config.json");
    const cfg = readJson(fp, {}) || {};
    const old = cfg.storeAuth;
    if (!old || !old.token) return;
    if (!authStore.load()) {
      authStore.save({
        token: String(old.token),
        user: {
          id: old.userId || (old.user && old.user.id) || "",
          username: old.username || "",
          nickname: old.nickname || old.username || "",
          likesReceived: Number(old.likesReceived || 0) || 0,
          downloadsReceived: Number(old.downloadsReceived || 0) || 0,
          isAdmin: !!old.isAdmin,
        },
      });
    }
    delete cfg.storeAuth;
    writeJson(fp, cfg);
    notifyAuthChanged();
  } catch (err) {
    errLog("[auth] storeAuth 迁移失败：" + String((err && err.message) || err));
  }
}

async function storeRequest(opts) {
  try {
    const o = opts || {};
    const p = String(o.path || "");
    if (!p.startsWith("/")) return { ok: false, error: I18n.t("非法 URL") };
    const method = String(o.method || "GET").toUpperCase();
    const headers = {
      Accept: "*/*",
      "User-Agent": "MTNodeAIO/1.1",
    };
    /* 渲染层不再接触 token：未显式传 token 时用主进程保存的会话。
       anon / noAuth：显式匿名请求，跳过本机会话 token（如微信登录 start，
       带 token 会被服务端当成「绑定」意图）。 */
    const anon = !!(o.anon || o.noAuth);
    let token = o.token ? String(o.token) : "";
    if (!token && !anon) {
      const cur = authStore.load();
      if (cur) token = cur.token;
    }
    if (token) headers.Authorization = "Bearer " + token;
    let body;
    if (o.json != null) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    }
    /* 手动跟随重定向（redirect:"manual"）：API 客户端语义要求原样保留
       method / headers / body，而 undici 默认跟随会把 301/302/303 的 POST
       降级成 GET —— nginx 上线 SSL 后 http→https 301，服务端就只剩 GET
       路由缺失，返回 404 not found（短信/密码登录、auth:bind/unbind、
       论坛发帖等所有 POST 全部受影响）。 */
    let url = STORE_BASE + p;
    let res;
    for (let hop = 0; hop <= 3; hop++) {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(120000),
      });
      const st = res.status;
      if (st !== 301 && st !== 302 && st !== 303 && st !== 307 && st !== 308) break;
      if (hop === 3) return { ok: false, error: I18n.t("重定向次数过多") };
      const loc = String(res.headers.get("location") || "");
      if (!loc) return { ok: false, error: "HTTP " + st };
      try {
        if (res.body) await res.body.cancel();
      } catch {}
      let next = "";
      try {
        next = new URL(loc, url).href;
      } catch {
        return { ok: false, error: I18n.t("非法 URL") };
      }
      if (!/^https?:\/\//i.test(next)) return { ok: false, error: I18n.t("非法 URL") };
      url = next;
    }
    const ct = String(res.headers.get("content-type") || "");
    if (ct.includes("application/json")) {
      const data = await res.json();
      return { ok: !!res.ok && data && data.ok !== false, status: res.status, data };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      base64: buf.toString("base64"),
      contentType: ct,
      bytes: buf.length,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

ipcMain.handle("store:request", (e, opts) => storeRequest(opts));

/* ---------------- 账户与登录（契约见 docs/auth-design.md，接口全部走 storeRequest） ---------------- */

function authFail(r, fallback) {
  const d = (r && r.data) || {};
  const out = {
    ok: false,
    status: Number((r && r.status) || 0) || 0,
    code: String(d.code || (r && r.code) || ""),
    error: String(d.error || (r && r.error) || fallback || I18n.t("网络请求失败")),
  };
  /* 冲突透传：身份已被其它账号占用（409 WECHAT_OWNED_BY_OTHER 等）时，服务端随
     data.owner 给出占用账号摘要，渲染层据此给出可操作选择，不能被只取 code/error 吞掉。 */
  if (d.owner != null) out.owner = d.owner;
  return out;
}

/* 登录成功后只回账号摘要；token 落 auth-store，不经过渲染层。 */
function authOkWithToken(d) {
  const saved = authStore.save({ token: d.token, user: d.user });
  notifyAuthChanged();
  return {
    ok: true,
    user: authStore.sanitizeUser(d.user),
    created: !!d.created,
    encryption: saved.encryption || "plain",
    warning: saved.warning || "",
  };
}

ipcMain.handle("auth:state", () => authStore.state());

/* 旧账号密码登录 / 改密：接口沿用 /api/login 与 /api/change-password，
   但换发的 token 由主进程落 auth-store，渲染层（商店 / 论坛）只拿账号摘要。 */
ipcMain.handle("auth:loginPassword", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/login",
    json: {
      username: String(b.username || "").trim(),
      password: String(b.password || ""),
    },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("登录失败"));
  const d = r.data || {};
  if (!d.token) return { ok: false, code: "", error: I18n.t("登录响应缺少凭据") };
  return authOkWithToken(d);
});

ipcMain.handle("auth:changePassword", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/change-password",
    json: {
      username: String(b.username || "").trim(),
      oldPassword: String(b.oldPassword || ""),
      newPassword: String(b.newPassword || ""),
    },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("修改密码失败"));
  const d = r.data || {};
  if (!d.token) return { ok: false, code: "", error: I18n.t("登录响应缺少凭据") };
  return authOkWithToken(d);
});

ipcMain.handle("auth:smsSend", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/auth/sms/send",
    json: {
      phone: String(b.phone || "").trim(),
      scene: b.scene === "bind" ? "bind" : "login",
    },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("验证码发送失败"));
  const d = r.data || {};
  return {
    ok: true,
    expiresIn: Number(d.expiresIn || 300) || 300,
    cooldown: Number(d.cooldown || 60) || 60,
  };
});

ipcMain.handle("auth:smsLogin", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/auth/sms/login",
    json: { phone: String(b.phone || "").trim(), code: String(b.code || "").trim() },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("登录失败"));
  const d = r.data || {};
  if (!d.token) return { ok: false, code: "", error: I18n.t("登录响应缺少凭据") };
  return authOkWithToken(d);
});

ipcMain.handle("auth:wechatStart", async (e, payload) => {
  /* scene=bind（当前账号绑定微信）：必须带上本机会话 token，服务端据此把
     bindUserId 写进 device，扫码后 poll 才会「绑定到当前账号」并回 user。
     登录场景必须匿名：带 token 会被服务端当成「绑定」意图（绑定走 auth:bind + ticket）。
     且 STORE_BASE 必须直达 https，避免 http→https 301 被客户端降级成 GET。 */
  const b = payload || {};
  const bind = String(b.scene || "") === "bind";
  const r = await storeRequest({ method: "POST", path: "/api/auth/wechat/start", anon: !bind });
  if (!r || !r.ok) return authFail(r, I18n.t("微信登录不可用"));
  const d = r.data || {};
  return {
    ok: true,
    deviceCode: String(d.deviceCode || d.device_code || ""),
    authUrl: String(d.authUrl || ""),
    expiresIn: Number(d.expiresIn || 300) || 300,
    interval: Number(d.interval || 2) || 2,
  };
});

ipcMain.handle("auth:wechatPoll", async (e, payload) => {
  const b = payload || {};
  const r = await storeRequest({
    method: "POST",
    path: "/api/auth/wechat/poll",
    json: { deviceCode: String(b.deviceCode || b.device_code || "").trim() },
  });
  if (!r || !r.ok) return authFail(r, I18n.t("微信登录失败"));
  const d = r.data || {};
  const status = String(d.status || "");
  if (status !== "done") return { ok: true, status: status || "pending" };
  /* ① 新版形状：服务端在 poll 内直接签发 token → 落本机会话，token 只留主进程，
     渲染层只拿账号摘要（不再回传 token）。 */
  if (d.token) {
    const okd = authOkWithToken(d);
    return {
      ok: true,
      status: "done",
      user: okd.user,
      bound: !!d.bound,
      created: okd.created,
      encryption: okd.encryption,
      warning: okd.warning,
      /* 服务端在合并账号时回传 merged / mergedFrom（合并了哪些身份），渲染层据此提示用户。 */
      merged: !!d.merged,
      mergedFrom: d.mergedFrom != null ? d.mergedFrom : null,
    };
  }
  /* ② 旧版形状：done 但无 token，只给了 ticket / bind 标记 → 用本机会话 token 走
     /api/auth/bind 完成绑定（会话 token 不变，仅更新账号摘要）。 */
  if (d.ticket || d.bind) {
    const rb = await storeRequest({
      method: "POST",
      path: "/api/auth/bind",
      json: { kind: "wechat", ticket: d.ticket ? String(d.ticket) : "" },
    });
    if (!rb || !rb.ok) return authFail(rb, I18n.t("微信登录失败"));
    const bd = rb.data || {};
    authStore.updateUser(bd.user);
    notifyAuthChanged();
    return {
      ok: true,
      status: "done",
      user: authStore.sanitizeUser(bd.user),
      bound: true,
      created: !!bd.created,
    };
  }
  /* ③ 两者皆无：既没签发凭据也没给 ticket —— 显式报错，避免渲染层静默当成成功。 */
  return {
    ok: false,
    code: "WECHAT_NO_CREDENTIAL",
    error: I18n.t("微信登录未返回凭据"),
  };
});

/* 本机微信 PC 版：检测安装 / 启动或置前（不做注入、不读本地数据、不联网） */
ipcMain.handle("auth:wechatLocal", async () => {
  try {
    return await wechatPc.detect();
  } catch (e) {
    return {
      installed: false,
      exe: "",
      kind: "",
      version: "",
      running: false,
      error: String((e && e.message) || e || ""),
    };
  }
});

ipcMain.handle("auth:wechatLaunch", async () => {
  try {
    return await wechatPc.launch();
  } catch (e) {
    return {
      ok: false,
      launched: false,
      foreground: false,
      exe: "",
      error: String((e && e.message) || e || ""),
    };
  }
});

ipcMain.handle("auth:me", async () => {
  const cur = authStore.load();
  if (!cur) return { ok: false, code: "UNAUTHORIZED", error: I18n.t("未登录") };
  const r = await storeRequest({ method: "GET", path: "/api/me" });
  if (!r || !r.ok) {
    if (Number((r && r.status) || 0) === 401) {
      authStore.clear();
      notifyAuthChanged();
    }
    return authFail(r, I18n.t("获取账号信息失败"));
  }
  const d = r.data || {};
  authStore.updateUser(d.user);
  return { ok: true, user: authStore.sanitizeUser(d.user) };
});

ipcMain.handle("auth:setNickname", async (e, payload) => {
  const b = payload || {};
  const cur = authStore.load();
  if (!cur) return { ok: false, code: "UNAUTHORIZED", error: I18n.t("未登录") };
  const r = await storeRequest({
    method: "PATCH",
    path: "/api/me",
    json: { nickname: String(b.nickname != null ? b.nickname : "") },
  });
  if (!r || !r.ok) {
    if (Number((r && r.status) || 0) === 401) {
      authStore.clear();
      notifyAuthChanged();
    }
    return authFail(r, I18n.t("修改昵称失败"));
  }
  const d = r.data || {};
  authStore.updateUser(d.user);
  notifyAuthChanged();
  return { ok: true, user: authStore.sanitizeUser(d.user) };
});

ipcMain.handle("auth:bind", async (e, payload) => {
  const b = payload || {};
  const kind = String(b.kind || "").trim().toLowerCase();
  if (!["phone", "wechat", "password"].includes(kind)) {
    return { ok: false, code: "UNKNOWN_KIND", error: I18n.t("不支持的绑定类型") };
  }
  const json = { kind };
  if (b.phone != null) json.phone = String(b.phone).trim();
  if (b.code != null) json.code = String(b.code).trim();
  if (b.password != null) json.password = String(b.password);
  if (b.newPassword != null) json.newPassword = String(b.newPassword);
  if (b.ticket != null) json.ticket = String(b.ticket).trim();
  const r = await storeRequest({ method: "POST", path: "/api/auth/bind", json });
  if (!r || !r.ok) return authFail(r, I18n.t("绑定失败"));
  const d = r.data || {};
  authStore.updateUser(d.user);
  notifyAuthChanged();
  return { ok: true, user: authStore.sanitizeUser(d.user) };
});

ipcMain.handle("auth:unbind", async (e, payload) => {
  const b = payload || {};
  const kind = String(b.kind || "").trim().toLowerCase();
  if (!["phone", "wechat", "password"].includes(kind)) {
    return { ok: false, code: "UNKNOWN_KIND", error: I18n.t("不支持的解绑类型") };
  }
  const json = { kind };
  if (b.password != null) json.password = String(b.password);
  if (b.code != null) json.code = String(b.code).trim();
  const r = await storeRequest({ method: "POST", path: "/api/auth/unbind", json });
  if (!r || !r.ok) return authFail(r, I18n.t("解绑失败"));
  const d = r.data || {};
  authStore.updateUser(d.user);
  notifyAuthChanged();
  return { ok: true, user: authStore.sanitizeUser(d.user) };
});

ipcMain.handle("auth:logout", async () => {
  /* 无 token 也幂等成功；无论服务端结果如何都清掉本机凭据。 */
  try {
    await storeRequest({ method: "POST", path: "/api/logout" });
  } catch {}
  authStore.clear();
  notifyAuthChanged();
  return { ok: true };
});

ipcMain.handle("store:pickMtNodes", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("选择 .mtnodes 模板文件"),
      properties: ["openFile"],
      filters: [{ name: I18n.t("MTNode 画布"), extensions: ["mtnodes"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: I18n.t("已取消") };
    const buf = fs.readFileSync(r.filePaths[0]);
    if (buf.length < 8 || buf.slice(0, 7).toString("ascii") !== "MTNODES") {
      return { ok: false, error: I18n.t("不是有效的 .mtnodes 画布文件") };
    }
    return {
      ok: true,
      base64: buf.toString("base64"),
      bytes: buf.length,
      name: path.basename(r.filePaths[0]),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

function isSkillMdBasename(name) {
  return /^skill\.md$/i.test(String(name || "").trim());
}

ipcMain.handle("store:pickSkillMd", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("选择 SKILL.md 与附加文件"),
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Skill",
          extensions: ["md", "markdown", "txt", "json", "yaml", "yml", "csv"],
        },
        { name: I18n.t("全部文件"), extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, error: I18n.t("已取消") };
    let skill = null;
    const files = [];
    for (const fp of r.filePaths) {
      const name = path.basename(fp);
      const buf = fs.readFileSync(fp);
      if (!buf.length) {
        return { ok: false, error: I18n.t("文件为空") + "：" + name };
      }
      if (buf.length > 200 * 1024) {
        return { ok: false, error: I18n.t("每个文件不能超过 200KB") + "：" + name };
      }
      if (isSkillMdBasename(name)) {
        if (skill) {
          return { ok: false, error: I18n.t("只能包含一个 SKILL.md") };
        }
        const text = buf.toString("utf8");
        if (!text.trim()) return { ok: false, error: I18n.t("文件为空") };
        skill = {
          base64: buf.toString("base64"),
          text,
          bytes: buf.length,
          name,
        };
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        return { ok: false, error: I18n.t("文件名不合法：") + name };
      }
      files.push({
        path: name,
        base64: buf.toString("base64"),
        bytes: buf.length,
        name,
      });
    }
    if (!skill) {
      return { ok: false, error: I18n.t("请包含 SKILL.md") };
    }
    if (files.length > 32) {
      return { ok: false, error: I18n.t("附加文件不能超过 32 个") };
    }
    return {
      ok: true,
      base64: skill.base64,
      text: skill.text,
      bytes: skill.bytes,
      name: skill.name,
      files,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:pickSkillFiles", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("选择技能附加文件"),
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: I18n.t("技能附件"), extensions: ["md", "markdown", "txt", "json", "yaml", "yml", "csv"] },
        { name: I18n.t("全部文件"), extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, error: I18n.t("已取消") };
    const files = [];
    for (const fp of r.filePaths) {
      const buf = fs.readFileSync(fp);
      const name = path.basename(fp);
      if (name.toLowerCase() === "skill.md") {
        return { ok: false, error: I18n.t("附加文件不要使用 SKILL.md") };
      }
      if (buf.length > 200 * 1024) {
        return { ok: false, error: I18n.t("每个文件不能超过 200KB") + "：" + name };
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        return { ok: false, error: I18n.t("文件名不合法：") + name };
      }
      files.push({
        path: name,
        base64: buf.toString("base64"),
        bytes: buf.length,
        name,
      });
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:pickPreview", async () => {
  try {
    const r = await dialog.showOpenDialog(win(), {
      title: I18n.t("选择预览图像"),
      properties: ["openFile"],
      filters: [{ name: I18n.t("图像"), extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: I18n.t("已取消") };
    const raw = fs.readFileSync(r.filePaths[0]);
    const ext = path.extname(r.filePaths[0]);
    const fullShrunk = shrinkImageBuffer(raw, ext, 640);
    let fullImg = nativeImage.createFromBuffer(fullShrunk.buf);
    if (!fullImg || fullImg.isEmpty()) return { ok: false, error: I18n.t("无法读取该文件路径") };
    const jpg = fullImg.toJPEG(82);
    const thumbShrunk = shrinkImageBuffer(jpg, ".jpg", 240);
    let thumbImg = nativeImage.createFromBuffer(thumbShrunk.buf);
    const thumbJpg =
      thumbImg && !thumbImg.isEmpty() ? thumbImg.toJPEG(72) : jpg;
    const sz = fullImg.getSize();
    return {
      ok: true,
      base64: jpg.toString("base64"),
      thumbBase64: thumbJpg.toString("base64"),
      mime: "image/jpeg",
      bytes: jpg.length,
      thumbBytes: thumbJpg.length,
      width: sz.width,
      height: sz.height,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

const storeCacheDir = () => mk(join(DATA(), "store-cache"));
function storeCachePath(id) {
  return join(storeCacheDir(), String(id).replace(/[^\w.-]/g, "_") + ".mtnodes");
}
function storeCacheMetaPath(id) {
  return join(storeCacheDir(), String(id).replace(/[^\w.-]/g, "_") + ".json");
}

ipcMain.handle("store:cacheGet", (e, id) => {
  try {
    const tid = String(id || "");
    if (!tid) return { ok: false };
    const fp = storeCachePath(tid);
    if (!fs.existsSync(fp)) return { ok: false };
    const buf = fs.readFileSync(fp);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(storeCacheMetaPath(tid), "utf8"));
    } catch {}
    return {
      ok: true,
      base64: buf.toString("base64"),
      bytes: buf.length,
      title: meta.title || "",
      cachedAt: meta.cachedAt || 0,
      updatedAt: meta.updatedAt || 0,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:cachePut", (e, opts) => {
  try {
    const o = opts || {};
    const tid = String(o.id || "");
    if (!tid || !o.base64) return { ok: false, error: "missing" };
    const buf = Buffer.from(String(o.base64).replace(/\s+/g, ""), "base64");
    if (buf.length < 8 || buf.slice(0, 7).toString("ascii") !== "MTNODES") {
      return { ok: false, error: I18n.t("不是有效的 .mtnodes 画布文件") };
    }
    fs.writeFileSync(storeCachePath(tid), buf);
    writeJson(storeCacheMetaPath(tid), {
      id: tid,
      title: String(o.title || ""),
      cachedAt: Date.now(),
      bytes: buf.length,
      updatedAt: o.updatedAt != null ? Number(o.updatedAt) || 0 : 0,
    });
    return { ok: true, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:cacheDelete", (e, id) => {
  try {
    const tid = String(id || "");
    if (!tid) return { ok: false };
    try {
      fs.unlinkSync(storeCachePath(tid));
    } catch {}
    try {
      fs.unlinkSync(storeCacheMetaPath(tid));
    } catch {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("store:cacheHas", (e, id) => {
  try {
    return { ok: true, has: fs.existsSync(storeCachePath(String(id || ""))) };
  } catch {
    return { ok: true, has: false };
  }
});

/* 打开存档目录（工作流 save 文件夹） */
ipcMain.handle("storage:open", () => {
  try {
    const dir = mk(join(DATA(), "save"));
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

function copyDirRecursive(src, dest) {
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writeDataRootPointer(dataPath) {
  mk(APP_DATA_ROOT);
  if (!dataPath) {
    try {
      fs.unlinkSync(DATA_ROOT_POINTER);
    } catch {}
    return;
  }
  writeJson(DATA_ROOT_POINTER, { path: dataPath });
}

/* 应用目录（渲染层事实库守卫用）：app.getAppPath() 与 exe 所在目录。
   渲染层解析事实库路径后用它与主进程 factLibDirOf 做**同口径**拒绝判定。 */
ipcMain.handle("app:dirs", () => {
  try {
    return {
      ok: true,
      appPath: APP_DIRS[0] || "",
      exeDir: APP_DIRS[1] || "",
      dirs: APP_DIRS.slice(),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/* 配置数据目录（config.json / API Key / 工作流等）；更改后需重启 */
ipcMain.handle("data:getRoot", () => {
  try {
    const def = defaultDataDir();
    const cur = DATA();
    const override = process.env.MTNODE_DATA_DIR ? null : readDataRootOverride();
    return {
      ok: true,
      path: cur,
      defaultPath: def,
      isCustom: !!(override && path.resolve(override) !== path.resolve(def)),
      envLocked: !!process.env.MTNODE_DATA_DIR,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("data:setRoot", async (e, opts) => {
  try {
    if (process.env.MTNODE_DATA_DIR) {
      return {
        ok: false,
        error: I18n.t("当前由环境变量 MTNODE_DATA_DIR 指定数据目录，无法在设置中更改"),
      };
    }
    const o = opts || {};
    const migrate = o.migrate !== false;
    let next = o.path == null ? "" : String(o.path).trim();
    if (!next) {
      writeDataRootPointer(null);
      return { ok: true, path: defaultDataDir(), needsRestart: true, reset: true };
    }
    if (!path.isAbsolute(next)) {
      return { ok: false, error: I18n.t("请选择绝对路径") };
    }
    next = path.resolve(next);
    const cur = path.resolve(DATA());
    if (next === cur) {
      return { ok: true, path: cur, needsRestart: false, unchanged: true };
    }
    mk(next);
    try {
      fs.accessSync(next, fs.constants.W_OK);
    } catch {
      return { ok: false, error: I18n.t("目录不可写") };
    }
    const destCfg = join(next, "config.json");
    if (migrate && !fs.existsSync(destCfg) && fs.existsSync(join(cur, "config.json"))) {
      try {
        copyDirRecursive(cur, next);
      } catch (err) {
        return {
          ok: false,
          error:
            I18n.t("复制现有配置失败：") + ((err && err.message) || String(err)),
        };
      }
    }
    writeDataRootPointer(next);
    return { ok: true, path: next, needsRestart: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("data:openRoot", () => {
  try {
    const dir = mk(DATA());
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("app:relaunch", () => {
  app.relaunch();
  app.quit();
  return { ok: true };
});

/* GIF 帧动画编码：frames = [{data: ArrayBuffer(RGBA), w, h}]；alpha=0 像素透明 */
ipcMain.handle("gif:make", (e, { wfId, name, frames, delay }) => {
  try {
    const { GIFEncoder, quantize, applyPalette } = gifenc();
    const encoder = GIFEncoder();
    for (const f of frames || []) {
      const data = new Uint8ClampedArray(f.data);
      const palette = quantize(data, 255, {
        format: "rgba4444",
        oneBitAlpha: true,
      });
      const index = applyPalette(data, palette, "rgba4444");
      let transp = -1;
      for (let i = 0; i < palette.length; i++) {
        if (palette[i][3] === 0) {
          transp = i;
          break;
        }
      }
      if (transp >= 0) {
        for (let p = 0; p < index.length; p++) {
          if (data[p * 4 + 3] === 0) index[p] = transp;
        }
        encoder.writeFrame(index, f.w, f.h, {
          palette,
          delay: delay || 160,
          transparent: true,
          transparentIndex: transp,
        });
      } else {
        encoder.writeFrame(index, f.w, f.h, { palette, delay: delay || 160 });
      }
    }
    encoder.finish();
    const gif = encoder.bytes();
    const dest = join(
      assetDir(wfId),
      String(name).replace(/[^\w.-]/g, "_") + ".gif",
    );
    fs.writeFileSync(dest, Buffer.from(gif));
    return { ok: true, path: dest, frames: (frames || []).length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ---------------- IPC：AI 接口调用（主进程发起，无 CORS 限制） ---------------- */

function apiErr(status, j, text) {
  const msg = j && j.error && (j.error.message || String(j.error));
  if (msg) return `HTTP ${status}：${String(msg).slice(0, 300)}`;
  const t = String(text || "").slice(0, 300);
  return `HTTP ${status}${t ? "：" + t : ""}`;
}

/* 运行中请求的中止：key -> Set<request> */
const activeRequests = new Map();
function registerRequest(key, req) {
  if (!key) return;
  let s = activeRequests.get(key);
  if (!s) {
    s = new Set();
    activeRequests.set(key, s);
  }
  s.add(req);
  req.on("close", () => {
    s.delete(req);
    if (!s.size) activeRequests.delete(key);
  });
}
ipcMain.handle("api:abort", (e, key) => {
  if (key) {
    const s = activeRequests.get(key);
    if (s) for (const req of [...s]) req.destroy(new Error(I18n.t("请求已中止")));
  }
  return { ok: true };
});

/* 使用 http/https 直接发请求：每次新建连接（Connection: close），
   避免 keep-alive 池中半开连接导致的下一次请求长时间挂起；
   超时覆盖整个请求（含响应体读取）。
   timeoutMs 传 0 = 不设时限：生图这类耗时不定的长任务用它，
   要停可点节点上的 ■ 停止（走 activeRequests 中止），不靠超时兜底。 */
function effectiveTimeout(timeoutMs) {
  const t = Number(timeoutMs);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

async function fetchJson(url, opts, timeoutMs = 180000, reqKey) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const headers = Object.assign({ Connection: "close" }, opts.headers || {});
  let payload = null;
  if (opts.body instanceof FormData) {
    const boundary =
      "----MTNode" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
    const parts = [];
    for (const [k, v] of opts.body.entries()) {
      if (typeof v === "string") {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
          ),
        );
      } else if (v && typeof v.arrayBuffer === "function") {
        const buf = Buffer.from(await v.arrayBuffer());
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${v.name || "file"}"\r\nContent-Type: ${v.type || "application/octet-stream"}\r\n\r\n`,
          ),
        );
        parts.push(buf);
        parts.push(Buffer.from("\r\n"));
      }
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    payload = Buffer.concat(parts);
    headers["Content-Type"] = "multipart/form-data; boundary=" + boundary;
    headers["Content-Length"] = payload.length;
  } else if (opts.body !== undefined && opts.body !== null) {
    payload = Buffer.from(
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      "utf8",
    );
    headers["Content-Length"] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method: opts.method || "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let j = null;
          try {
            j = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, j, text });
        });
        res.on("error", (e) => reject(e));
      },
    );
    const tmoJson = effectiveTimeout(timeoutMs);
    if (tmoJson)
      req.setTimeout(tmoJson, () => req.destroy(new Error(I18n.t("请求超时"))));
    req.on("error", (e) => reject(e));
    if (reqKey) registerRequest(reqKey, req);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchRaw(url, timeoutMs = 60000, reqKey) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method: "GET", headers: { Connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }),
        );
        res.on("error", (e) => reject(e));
      },
    );
    const tmoRaw = effectiveTimeout(timeoutMs);
    if (tmoRaw)
      req.setTimeout(tmoRaw, () =>
        req.destroy(new Error(I18n.t("下载图像超时"))),
      );
    req.on("error", (e) => reject(e));
    if (reqKey) registerRequest(reqKey, req);
    req.end();
  });
}

/* gpt-image-2-vip 支持的全部 size 档位（含 auto） */
const GPT_IMAGE_SIZES = [
  "auto",
  "1280x1280",
  "848x1280",
  "1280x848",
  "960x1280",
  "1280x960",
  "1024x1280",
  "1280x1024",
  "720x1280",
  "1280x720",
  "1280x544",
  "2048x2048",
  "1360x2048",
  "2048x1360",
  "1536x2048",
  "2048x1536",
  "1632x2048",
  "2048x1632",
  "1152x2048",
  "2048x1152",
  "2048x864",
  "2880x2880",
  "2336x3520",
  "3520x2336",
  "2480x3312",
  "3312x2480",
  "2560x3216",
  "3216x2560",
  "2160x3840",
  "3840x2160",
  "3840x1632",
];

/* 兼容 base64 带/不带 data: 前缀 */
function normB64(v) {
  if (typeof v !== "string") return null;
  if (v.startsWith("data:")) {
    const i = v.indexOf(",");
    return i >= 0 ? v.slice(i + 1) : v;
  }
  return v;
}

/* 读取参考图并缩放到不超过 API_REF_IMAGE_MAX_DIM（等比）后再发 API。无法解码或已达标时原样返回。
   native=true：透明图差分抠图的锚定参考图（第 1 通道基准），按原尺寸下发，
   仅在体积超过上限时兜底压到 API_MATTE_REF_MAX_DIM。 */
function shrinkImageForApi(p, native) {
  const raw = fs.readFileSync(p);
  const ext = String(path.extname(p)).slice(1).toLowerCase() || "png";
  if (native && raw.length <= API_MATTE_REF_NATIVE_MAX_BYTES)
    return { buf: raw, ext };
  return shrinkImageBuffer(
    raw,
    ext,
    native ? API_MATTE_REF_MAX_DIM : API_REF_IMAGE_MAX_DIM,
  );
}

/* 本地图像文件的实际像素尺寸（读不出 / 解不开返回 null，不抛错） */
function imagePixelDims(p) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    const img = nativeImage.createFromPath(String(p));
    if (!img || img.isEmpty()) return null;
    const { width, height } = img.getSize();
    return width > 0 && height > 0 ? { w: width, h: height } : null;
  } catch {
    return null;
  }
}

/* 把「第 1 通道实际返回的像素尺寸」钉成 size 档位：两通道同宽同高是差分的前提。
   auto（以及接口偷偷换了分辨率的情况）会让两通道各自挑尺寸，
   下游对齐只能把图非等比铺满 → 又糊又错位。先要精确命中档位，否则取
   「长宽比最接近、其次面积最接近」的档位（长宽比权重高于面积权重）。 */
function gptImageSizeForDims(w, h) {
  if (!(w > 0 && h > 0)) return "";
  const tiers = GPT_IMAGE_SIZES.filter((s) => s !== "auto");
  const exact = w + "x" + h;
  if (tiers.includes(exact)) return exact;
  let best = "";
  let bestScore = Infinity;
  for (const s of tiers) {
    const m = /^(\d+)x(\d+)$/.exec(s);
    if (!m) continue;
    const tw = Number(m[1]);
    const th = Number(m[2]);
    const score =
      Math.abs(Math.log(tw / th / (w / h))) * 10 +
      Math.abs(Math.log((tw * th) / (w * h)));
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/* 文本模型思考强度 → Chat Completions 字段（映射方式参考 dsh-llm-deepseek）：
   - off / 无 → thinking.type = disabled，且不发送 reasoning_effort（关闭思考）
   - low / high / max → thinking.type = enabled + reasoning_effort
   - medium / xhigh → high；legacy none / minimal → low（旧数据兼容） */
function applyTextThinkingEffort(body, effort) {
  const raw = String(effort == null ? "" : effort)
    .trim()
    .toLowerCase();
  if (!raw) return;
  let e = raw;
  if (e === "medium" || e === "xhigh") e = "high";
  if (e === "none" || e === "minimal") e = "low";
  if (e === "无") e = "off";
  if (e === "off") {
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
    return;
  }
  body.thinking = { type: "enabled" };
  if (e === "low" || e === "high" || e === "max") body.reasoning_effort = e;
  else body.reasoning_effort = "high";
}

/* ── gpt-image-2 图像参数：quality / background / mask（蒙版局部重绘）────────
   quality    只接受官方六个枚举值。旧版 DALL·E 的 standard / hd 不要传：不同渠道下
              有时 400（invalid_value）、有时被静默忽略按 auto 计费（费用不可控）。
   background transparent / opaque / auto；传 transparent 时 output_format 必须是
              png（配 jpeg 会 400）。编辑接口的透明是「重绘去背」，不是精确抠像。
   mask       仅对第 1 张 image 生效，须与原图同尺寸、带 alpha 通道的 PNG（<4MB）。
              语义：**透明区域 = 允许模型编辑**，不透明区域 = 尽量保留原图。
   参考：https://docs.apiyi.com/api-capabilities/gpt-image-2/image-edit
        https://docs.apiyi.com/api-capabilities/gpt-image-2/mask-editing           */
const GPT_IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"];
const GPT_IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"];
function apiQualityOf(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return GPT_IMAGE_QUALITIES.includes(s) ? s : "";
}
function apiBackgroundOf(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return GPT_IMAGE_BACKGROUNDS.includes(s) ? s : "";
}
/* 蒙版与原图必须同尺寸：走同一个 shrinkImageForApi 口径（同 maxDim、同源尺寸 ⇒ 同缩放比），
   否则压过的原图配未压的蒙版会被接口判为尺寸不符。 */
function apiMaskPathOf(v) {
  const s = String(v == null ? "" : v).trim();
  return s && fs.existsSync(s) ? s : "";
}
/* gpt-image-2 自定义尺寸约束：宽高都是 16 的倍数、最长边 ≤ 3840、长宽比 ≤ 3:1、
   总像素 655,360–8,294,400（见上文参考文档「尺寸参数」）。 */
function gptImageSizeOk(w, h) {
  if (!(w > 0 && h > 0)) return false;
  if (w % 16 || h % 16) return false;
  if (Math.max(w, h) > 3840) return false;
  if (Math.max(w, h) / Math.min(w, h) > 3) return false;
  const px = w * h;
  return px >= 655360 && px <= 8294400;
}
/* 参考图「实际下发」的像素尺寸：native 通路原尺寸下发，只有超过体积上限才按上限等比缩小
   （与 shrinkImageForApi 同一口径）；读不出尺寸返回 null。 */
function apiSentImageDims(p, native) {
  const d = imagePixelDims(p);
  if (!d) return null;
  if (native) {
    /* 与 shrinkImageForApi 同口径：体积没超上限就是原尺寸原样下发（不缩放）。
       量不出体积（stat 失败）也按原尺寸算 —— 读不出文件时真正的读盘那步会直接报错。 */
    let bytes = 0;
    try {
      bytes = fs.statSync(p).size;
    } catch {
      return d;
    }
    if (bytes <= API_MATTE_REF_NATIVE_MAX_BYTES) return d;
  }
  const maxDim = native ? API_MATTE_REF_MAX_DIM : API_REF_IMAGE_MAX_DIM;
  if (!(d.w > maxDim || d.h > maxDim)) return d;
  const s = Math.min(maxDim / d.w, maxDim / d.h);
  return { w: Math.max(1, Math.round(d.w * s)), h: Math.max(1, Math.round(d.h * s)) };
}
/* 带蒙版时的 size：**必须等于蒙版 / 原图的像素尺寸**。
   服务端是按 size 出图的：size 一旦与原图像素不同，它会先把输入图重排缩放再编辑，
   蒙版按原图像素画出来的空间对应关系就失效了 —— 实测表现为整张主体被重绘、蒙版形同没开
   （原图 1280×848 + 蒙版 1280×848 + size=1280x544：蒙版内/外主体的改动量一样大）。
   命中自定义尺寸约束就按原图像素原样出图；命中不了（或读不出尺寸）退回 auto，
   让接口按输入图决定画幅，宁可不要「非等比铺满」也比蒙版错位强。 */
function apiMaskSizeFor(p) {
  const d = apiSentImageDims(p, true);
  if (!d) return "auto";
  return gptImageSizeOk(d.w, d.h) ? d.w + "x" + d.h : "auto";
}

/* 构建完整请求描述（预览与真实调用共用，保证一致）
   matteAnchor：透明图差分抠图的**第 2 通道**（images[0] / refImage 就是第 1 通道基准图）。
   该通路两条口径：① 参考图不缩放、原尺寸下发；② size 钉成基准图实际像素对应的档位，
   保证两通道同宽同高（差分不接受「非等比铺满」）。 */
function buildRequestSpec(
  provider,
  kind,
  model,
  prompt,
  texts,
  images,
  refImage,
  temperature,
  size,
  chatMessages,
  effort,
  matteAnchor,
  imgOpts,
) {
  const base = String(provider.baseUrl).trim().replace(/\/+$/, "");
  const auth = {
    Authorization: "Bearer " + provider.apiKey,
    "Content-Type": "application/json",
  };
  if (kind === "text") {
    const parts = [];
    const vision = !!provider.vision;
    if (vision && images && images.length) {
      parts.push({ type: "text", text: prompt });
      for (const p of images) {
        const { buf, ext } = shrinkImageForApi(p);
        const mime =
          ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : "image/png";
        parts.push({
          type: "image_url",
          image_url: {
            url: "data:" + mime + ";base64," + buf.toString("base64"),
          },
        });
      }
    } else {
      parts.push({ type: "text", text: prompt });
    }
    const messages =
      chatMessages && chatMessages.length
        ? chatMessages
        : [{ role: "user", content: parts }];
    const body = {
      model,
      messages,
      temperature: temperature == null ? 0.7 : temperature,
    };
    /* DeepSeek V4：thinking 默认开启，附带 reasoning_effort */
    applyTextThinkingEffort(body, effort);
    return {
      method: "POST",
      url: base + "/chat/completions",
      headers: auth,
      body,
    };
  }
  if (provider.type === "image_openai") {
    let sz = GPT_IMAGE_SIZES.includes(size) ? size : "2048x1360";
    /* 差分抠图第 2 通道：size 以第 1 通道基准图的**实际像素**为准。
       auto 是合法档位且会被原样复制进第 2 请求 —— 两通道各自挑分辨率，
       下游只能非等比铺满对齐；接口偷改分辨率时同理。 */
    const anchored = !!matteAnchor && !!(images && images.length);
    if (anchored) {
      const d = imagePixelDims(images[0]);
      const pin = d ? gptImageSizeForDims(d.w, d.h) : "";
      if (pin) sz = pin;
    }
    /* 质量 / 背景：只在节点显式选过时才下发（空 = 不传，交给服务商默认 auto） */
    const quality = apiQualityOf(imgOpts && imgOpts.quality);
    const background = apiBackgroundOf(imgOpts && imgOpts.background);
    /* 蒙版局部重绘：必须先有原图（mask 只对第一张 image 生效） */
    const mask =
      images && images.length ? apiMaskPathOf(imgOpts && imgOpts.maskPath) : "";
    /* 带蒙版：size 跟着蒙版 / 原图的像素尺寸走，否则服务端重排输入图会让蒙版错位（见 apiMaskSizeFor） */
    if (mask) sz = apiMaskSizeFor(images[0]);
    if (images && images.length) {
      /* 带参考图：/images/edits multipart，多图按顺序 = prompt 中的图1/图2/… */
      const form = {
        model: model || "gpt-image-2-vip",
        prompt,
        size: sz,
        image: images.slice(),
      };
      if (quality) form.quality = quality;
      if (background) form.background = background;
      /* background=transparent 必须配 png（服务端收到 jpeg 会 400） */
      if (background === "transparent") form.output_format = "png";
      if (mask) form.mask = mask;
      return {
        method: "POST",
        url: base + "/images/edits",
        headers: { Authorization: auth.Authorization },
        body: { __multipart: form },
        /* multipart 里的参考图不缩放（见 sendMultipart）。
           带蒙版时**必须**原尺寸：蒙版按原图像素画，原图被缩过就与原图对不上。 */
        nativeRefImage: anchored || !!mask,
      };
    }
    /* 文生图：/images/generations */
    const gen = {
      model: model || "gpt-image-2-vip",
      prompt,
      size: sz,
      response_format: "b64_json",
    };
    if (quality) gen.quality = quality;
    if (background) gen.background = background;
    if (background === "transparent") gen.output_format = "png";
    return {
      method: "POST",
      url: base + "/images/generations",
      headers: auth,
      body: gen,
    };
  }
  if (provider.type === "image_stability") {
    const form = { prompt, output_format: "png", aspect_ratio: "1:1" };
    if (model && model !== "core") form.model = model;
    if (refImage) form.image = refImage;
    return {
      method: "POST",
      url: base + "/v2beta/stable-image/generate/core",
      headers: {
        Authorization: auth.Authorization,
        Accept: "application/json",
      },
      body: { __multipart: form },
      /* 抠图第 2 通道：core 的 image 字段就是第 1 通道基准图，原尺寸下发。
         两通道走同一份 aspect_ratio（固定 1:1）→ 出图必然同宽同高，无需另钉档位。 */
      nativeRefImage: !!matteAnchor && !!refImage,
    };
  }
  if (provider.type === "image_mj") {
    return {
      method: "POST",
      url: base,
      headers: auth,
      body: { prompt, api_key: provider.apiKey, model: model || "imagine" },
    };
  }
  throw new Error(I18n.t("未知服务商类型：") + provider.type);
}

/* 已下发字节的真实像素尺寸（预览里用它显示「真正发出去的那份有多大」，读不出返回 null） */
function bufferPixelDims(buf) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (!img || img.isEmpty()) return null;
    const { width, height } = img.getSize();
    return width > 0 && height > 0 ? { w: width, h: height } : null;
  } catch {
    return null;
  }
}

/* multipart 表单 → 逐字段的分片列表。**sendMultipart（真正发请求）与 api:preview（请求预览）
   共用同一份实现**：预览里看到的就是真正下发的输入 —— 同一字段顺序、同一文件名、同一份字节。
   每片：{ name, buf, filename, path }（文件字段）或 { name, value }（普通字段）。
   soft=true（预览用）：文件读不出时不抛错，退化成 { name, path, error }，别让整个预览报错。 */
function multipartParts(form, nativeRefImage, soft) {
  const parts = [];
  const readFile = (p) => {
    try {
      return shrinkImageForApi(p, nativeRefImage);
    } catch (e) {
      if (!soft) throw e;
      return { error: e && e.message ? e.message : String(e) };
    }
  };
  for (const [k, v] of Object.entries(form || {})) {
    if (Array.isArray(v)) {
      let i = 1;
      for (const p of v) {
        if (!p) continue;
        const r = readFile(p);
        if (r.error) parts.push({ name: k, path: String(p), error: r.error });
        else
          parts.push({
            name: k,
            buf: r.buf,
            filename: "ref" + i + "." + r.ext,
            path: String(p),
          });
        i++;
      }
      continue;
    }
    if ((k === "image" || k === "mask") && typeof v === "string" && v) {
      /* 蒙版与参考图走同一缩放口径（同 maxDim、同源尺寸 ⇒ 同缩放比），保证与原图同尺寸 */
      const r = readFile(v);
      if (r.error) parts.push({ name: k, path: v, error: r.error });
      else
        parts.push({
          name: k,
          buf: r.buf,
          filename: (k === "mask" ? "mask." : "ref.") + r.ext,
          path: v,
        });
      continue;
    }
    parts.push({ name: k, value: String(v) });
  }
  return parts;
}

/* multipart 表单请求：image 字段支持字符串（单张）或数组（多张参考图，顺序=图1/图2/…）
   timeoutMs 传 0 = 不设时限（生图走这条）
   nativeRefImage：参考图不缩放原尺寸下发（透明图差分抠图的锚定通路，见 buildRequestSpec） */
async function sendMultipart(
  url,
  headers,
  form,
  timeoutMs = 180000,
  reqKey,
  nativeRefImage,
) {
  const fd = new FormData();
  for (const part of multipartParts(form, nativeRefImage)) {
    if (part.buf) fd.append(part.name, new Blob([part.buf]), part.filename);
    else fd.append(part.name, part.value);
  }
  return fetchJson(
    url,
    { method: "POST", headers, body: fd },
    timeoutMs,
    reqKey,
  );
}

function checkProvider(provider) {
  if (!provider) throw new Error(I18n.t("未配置服务商"));
  if (!String(provider.baseUrl || "").trim())
    throw new Error(I18n.t("未配置接口地址（设置 · API/配置）"));
  if (!String(provider.apiKey || "").trim())
    throw new Error(I18n.t("未配置 API Key（请在「设置 · API/配置」中填写）"));
}

async function apiCall({
  provider,
  kind,
  model,
  prompt,
  texts,
  images,
  refImage,
  temperature,
  size,
  chatMessages,
  effort,
  abKey,
  matteAnchor,
  quality,
  background,
  maskPath,
}) {
  checkProvider(provider);
  const req = buildRequestSpec(
    provider,
    kind,
    model,
    prompt,
    texts,
    images,
    refImage,
    temperature,
    size,
    chatMessages,
    effort,
    /* 抠图第 2 通道口径（参考图原尺寸下发 + size 钉死）由 spec 上的标记带入 */
    matteAnchor,
    /* gpt-image-2 图像参数：quality / background / mask 蒙版局部重绘 */
    { quality, background, maskPath },
  );

  if (kind === "text" || provider.type === "image_mj") {
    const { status, j, text } = await fetchJson(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
      },
      /* 文本保留默认 3 分钟时限；MJ 自定义接口是生图，不设上限 */
      kind === "text" ? undefined : 0,
      abKey,
    );
    if (status >= 400) throw new Error(apiErr(status, j, text));
    if (kind === "text") {
      const content =
        j &&
        j.choices &&
        j.choices[0] &&
        j.choices[0].message &&
        j.choices[0].message.content;
      if (content == null) throw new Error(I18n.t("响应无文本内容"));
      return { ok: true, text: String(content) };
    }
    let b64 = null,
      url = null;
    const take = (v) => {
      if (!v) return;
      if (typeof v === "string") {
        if (v.startsWith("data:")) b64 = v.split(",")[1] || null;
        else if (/^https?:\/\//.test(v)) url = v;
        else if (!b64) b64 = v;
      }
    };
    if (j) {
      take(j.image);
      if (j.images && j.images.length) j.images.forEach(take);
      if (j.data && j.data[0]) {
        take(j.data[0].url);
        take(j.data[0].b64_json);
        take(j.data[0].image);
      }
      take(j.url);
    }
    if (!b64 && !url)
      throw new Error(
        I18n.t("响应无图像数据（请检查自定义接口返回格式：{image: url|base64}）"),
      );
    if (url) {
      /* 取回生成结果的那张图：不设下载时限（0），慢网络也等得到 */
      const r = await fetchRaw(url, 0, abKey);
      if (r.status >= 400) throw new Error(I18n.t("下载图像失败 HTTP ") + r.status);
      b64 = r.buf.toString("base64");
    }
    return { ok: true, base64: b64, ext: "png" };
  }

  if (provider.type === "image_openai") {
    let status, j, text;
    if (req.body && req.body.__multipart) {
      /* 图生图 /images/edits：不设超时上限（0），高分辨率/多参考图都可能很久 */
      ({ status, j, text } = await sendMultipart(
        req.url,
        req.headers,
        req.body.__multipart,
        0,
        abKey,
        req.nativeRefImage,
      ));
    } else {
      /* 文生图 /images/generations：同样不设超时上限 */
      ({ status, j, text } = await fetchJson(
        req.url,
        {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(req.body),
        },
        0,
        abKey,
      ));
    }
    if (status >= 400) throw new Error(apiErr(status, j, text));
    const b64 = normB64(j && j.data && j.data[0] && j.data[0].b64_json);
    if (!b64) throw new Error(I18n.t("响应无图像数据"));
    return { ok: true, base64: b64, ext: "png" };
  }

  if (provider.type === "image_stability") {
    /* Stability 生图：不设超时上限（0） */
    const { status, j, text } = await sendMultipart(
      req.url,
      req.headers,
      req.body.__multipart,
      0,
      abKey,
      req.nativeRefImage,
    );
    if (status >= 400) throw new Error(apiErr(status, j, text));
    const b64 = normB64(
      (j && j.image) ||
        (j && j.artifacts && j.artifacts[0] && j.artifacts[0].base64),
    );
    if (!b64) throw new Error(I18n.t("响应无图像数据"));
    return { ok: true, base64: b64, ext: "png" };
  }

  throw new Error(I18n.t("未知服务商类型：") + provider.type);
}

/* 无 Token 消耗的 API Key 校验：OpenAI 兼容走 GET /models；
   Stability 走账户信息；均不触发计费推理/生图。 */
async function validateApiKey(provider) {
  checkProvider(provider);
  const base = String(provider.baseUrl).trim().replace(/\/+$/, "");
  const headers = {
    Authorization: "Bearer " + String(provider.apiKey).trim(),
    Accept: "application/json",
  };
  let url = base + "/models";
  if (provider.type === "image_stability") {
    url = base + "/v1/user/account";
  } else if (provider.type === "image_mj") {
    /* 自定义 MJ 网关多为单点 POST；用 GET 探测鉴权，不发起生图 */
    url = base;
  }
  const { status, j, text } = await fetchJson(
    url,
    { method: "GET", headers },
    30000,
  );
  if (status === 401 || status === 403) {
    return { ok: false, error: I18n.t("API Key 验证失败") };
  }
  if (status >= 400) {
    return {
      ok: false,
      error: I18n.t("API Key 验证失败") + "：" + apiErr(status, j, text),
    };
  }
  return { ok: true };
}

ipcMain.handle("api:validateKey", async (e, provider) => {
  try {
    return await validateApiKey(provider || {});
  } catch (err) {
    return {
      ok: false,
      error:
        I18n.t("API Key 验证失败") +
        "：" +
        ((err && err.message) || String(err)),
    };
  }
});

/* DeepSeek 余额查询：只读账户信息，不产生 Token 消耗 */
async function fetchDeepseekBalance(provider) {
  const p = provider || {};
  const base = String(p.baseUrl || "https://api.deepseek.com").trim().replace(/\/+$/, "");
  const apiKey = String(p.apiKey || "").trim();
  if (!apiKey) return { ok: false, error: I18n.t("未配置 API Key（请在「设置 · API/配置」中填写）") };
  if (!base) return { ok: false, error: I18n.t("未配置接口地址（设置 · API/配置）") };
  const headers = {
    Authorization: "Bearer " + apiKey,
    Accept: "application/json",
  };
  const { status, j, text } = await fetchJson(
    base + "/user/balance",
    { method: "GET", headers },
    15000,
  );
  if (status === 401 || status === 403) {
    return { ok: false, error: I18n.t("API Key 验证失败") };
  }
  if (status >= 400) {
    return { ok: false, error: apiErr(status, j, text) };
  }
  /* 原样透传官方字段（snake_case）。渲染层 app-cost.js 的 balanceNorm 认的就是这份
     契约；此前这里自造 camelCase（isAvailable / balances / totalBalance），渲染层
     解析不到 balance_infos，于是每次都显示「查询失败」。 */
  const infos = (j && Array.isArray(j.balance_infos)) ? j.balance_infos : [];
  return {
    ok: true,
    is_available: !!(j && j.is_available),
    balance_infos: infos,
  };
}

ipcMain.handle("api:deepseekBalance", async (e, provider) => {
  try {
    return await fetchDeepseekBalance(provider || {});
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || String(err),
    };
  }
});

ipcMain.handle("api:call", async (e, spec) => {
  try {
    return await apiCall(spec);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ---------------- 文本流式调用（SSE，支持思考内容 reasoning_content） ---------------- */

/* 普通 JSON 响应中提取内容（非流式回退 / 服务端忽略 stream 参数时用） */
function extractChatContent(j) {
  const c = j && j.choices && j.choices[0];
  if (!c) return { text: "", reasoning: "" };
  const m = c.message || {};
  return {
    text: m.content == null ? "" : String(m.content),
    reasoning: m.reasoning_content == null ? "" : String(m.reasoning_content),
  };
}

/* 发起流式 chat/completions 请求：
   - body 自动加 stream:true；
   - 服务端按 SSE（data: 行）返回 → 逐行解析 delta：
       delta.reasoning_content / delta.reasoning → 思考内容（emit('reasoning')）
       delta.content → 正文（emit('delta')）
     [DONE] 或流结束 → resolve({text, reasoning})；
   - 服务端忽略 stream 参数返回普通 JSON → 单次解析 message.content / reasoning_content；
   - HTTP ≥400 → reject（带 httpStatus，由调用方回退非流式）。 */
function streamTextChat(req, emit) {
  const u = new URL(req.url);
  const lib = u.protocol === "https:" ? https : http;
  const body = Object.assign({}, req.body, { stream: true });
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const headers = Object.assign({}, req.headers, {
    "Content-Length": payload.length,
    Connection: "close",
  });
  return new Promise((resolve, reject) => {
    const rq = lib.request(
      u,
      { method: req.method || "POST", headers },
      (res) => {
        let buf = "";
        let sse = false;
        let text = "";
        let reasoning = "";
        let finished = false;
        const finish = (t, r) => {
          if (!finished) {
            finished = true;
            resolve({ text: t, reasoning: r });
          }
        };
        if (res.statusCode >= 400) {
          res.on("data", (c) => {
            buf += c.toString("utf8");
          });
          res.on("end", () => {
            let j = null;
            try {
              j = JSON.parse(buf);
            } catch {}
            const e = new Error(apiErr(res.statusCode, j, buf));
            e.httpStatus = res.statusCode;
            reject(e);
          });
          return;
        }
        res.on("data", (c) => {
          buf += c.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            sse = true;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              finish(text, reasoning);
              return;
            }
            let j = null;
            try {
              j = JSON.parse(data);
            } catch {}
            if (!j || !j.choices || !j.choices[0]) continue;
            const d = j.choices[0].delta || {};
            if (d.reasoning_content != null && d.reasoning_content !== "") {
              reasoning += d.reasoning_content;
              emit("reasoning", { text: d.reasoning_content });
            }
            if (d.reasoning != null && d.reasoning !== "") {
              reasoning += d.reasoning;
              emit("reasoning", { text: d.reasoning });
            }
            if (d.content != null && d.content !== "") {
              text += d.content;
              emit("delta", { text: d.content });
            }
          }
        });
        res.on("end", () => {
          if (sse) {
            finish(text, reasoning);
            return;
          }
          let j = null;
          try {
            j = JSON.parse(buf);
          } catch {}
          const c = extractChatContent(j);
          if (c.reasoning) emit("reasoning", { text: c.reasoning });
          finish(c.text || text, c.reasoning || reasoning);
        });
        res.on("error", (e) => reject(e));
      },
    );
    rq.setTimeout(180000, () => rq.destroy(new Error(I18n.t("请求超时"))));
    rq.on("error", (e) => reject(e));
    if (req.abKey) registerRequest(req.abKey, rq);
    rq.write(payload);
    rq.end();
  });
}

/* 流式调用 IPC：事件经 webContents.send('api:streamEvent', {reqId, type, ...}) 推送。
   类型：reasoning（思考增量）| delta（正文增量）| done（{text}）| error（{error}）。
   兼容性：接口不支持 stream 时（HTTP 4xx）自动回退为非流式单次请求（无思考内容）。 */
ipcMain.handle("api:callStream", async (e, spec) => {
  const wc = e.sender;
  const reqId = spec && spec.reqId;
  const emit = (type, data) => {
    try {
      if (!wc.isDestroyed())
        wc.send("api:streamEvent", Object.assign({ reqId, type }, data || {}));
    } catch {}
  };
  try {
    checkProvider(spec.provider);
    if (spec.kind !== "text") {
      const r = await apiCall(spec);
      emit("done", { text: r.text || "" });
      return { ok: true };
    }
    const req = buildRequestSpec(
      spec.provider,
      spec.kind,
      spec.model,
      spec.prompt,
      spec.texts,
      spec.images,
      spec.refImage,
      spec.temperature,
      spec.size,
      spec.chatMessages,
      spec.effort,
    );
    if (spec.abKey) req.abKey = spec.abKey;
    const { text, reasoning } = await streamTextChat(req, emit);
    emit("done", { text, reasoning });
    return { ok: true };
  } catch (err) {
    if (err && err.httpStatus >= 400 && spec.kind === "text") {
      try {
        const r = await apiCall(spec);
        emit("done", { text: r.text || "" });
        return { ok: true };
      } catch (err2) {
        const m = err2.message || String(err2);
        emit("error", { error: m });
        return { ok: false, error: m };
      }
    }
    const m = err.message || String(err);
    emit("error", { error: m });
    return { ok: false, error: m };
  }
});
ipcMain.handle("api:preview", async (e, spec) => {
  try {
    checkProvider(spec.provider);
    const req = buildRequestSpec(
      spec.provider,
      spec.kind,
      spec.model,
      spec.prompt,
      spec.texts,
      spec.images,
      spec.refImage,
      spec.temperature,
      spec.size,
      spec.chatMessages,
      spec.effort,
      spec.matteAnchor,
      {
        quality: spec.quality,
        background: spec.background,
        maskPath: spec.maskPath,
      },
    );
    /* 预览 = **真正下发的输入**：
       - JSON 请求（文本 / 文生图 / MJ）照实回显 body。
       - multipart 请求（/images/edits、Stability）不回显内部的 { __multipart: {…} }：
         那份伪 JSON 里的 image / mask 只是本地路径数组，与线上的字段名、文件名、字节都对不上，
         用户会据此误判「路径不对 / 蒙版没传」。改为把 sendMultipart 真正会拼出的分片逐条列出 ——
         同一份 multipartParts 实现、同一字段顺序、同一文件名、同一份字节（含实际像素尺寸）。
       路径仍是纯路径：不再给 image / mask 套「参考图 / 蒙版」这类可读标签前缀。 */
    const mp = req.body && req.body.__multipart ? req.body.__multipart : null;
    const multipart = mp
      ? multipartParts(mp, !!req.nativeRefImage, true).map((p) =>
          p.buf
            ? {
                name: p.name,
                filename: p.filename,
                bytes: p.buf.length,
                dims: bufferPixelDims(p.buf),
                path: p.path,
              }
            : p.error
              ? { name: p.name, path: p.path, error: p.error }
              : { name: p.name, value: p.value },
        )
      : null;
    return {
      ok: true,
      request: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        multipart,
        body: mp ? null : JSON.parse(JSON.stringify(req.body)),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ---------------- dsh agent 网关 IPC ----------------
   事件推送走 dsh:event（main → renderer），见 dsh/DESIGN.md 本地协议一节。 */

ipcMain.handle("dsh:config", () => dshConfig());

ipcMain.handle("dsh:status", () =>
  dsh()
    .status()
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

ipcMain.handle("dsh:run", (event, params) =>
  dsh()
    .run(params)
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

ipcMain.handle("dsh:pluginList", () =>
  dsh()
    .pluginList()
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

ipcMain.handle("dsh:pluginAdd", (event, pkg) => dsh().pluginAdd(pkg));

ipcMain.handle("dsh:pluginRemove", (event, pkg) => dsh().pluginRemove(pkg));

ipcMain.handle("dsh:pluginSetEnabled", (event, { pkg, enabled, id }) =>
  dsh().pluginSetEnabled(pkg, enabled, id)
);

ipcMain.handle("dsh:mcpList", () => dsh().mcpList());

ipcMain.handle("dsh:mcpAdd", (event, cfg) => dsh().mcpAdd(cfg));

ipcMain.handle("dsh:mcpRemove", (event, serverName) => dsh().mcpRemove(serverName));

ipcMain.handle("dsh:mcpSetEnabled", (event, { serverName, enabled }) =>
  dsh().mcpSetEnabled(serverName, enabled)
);

ipcMain.handle("dsh:cancel", (event, params) => dsh().cancel(params));

ipcMain.handle("dsh:interact", (event, params) => dsh().interact(params));

/* 回滚收尾：向网关取回本轮 done 之后才到达的 journal 帧（渲染层封口前调一次）。
   老版网关没有这个 method 时按错误返回，渲染层降级为「只靠事件推」。 */
ipcMain.handle("dsh:rollbackDrain", (event, params) =>
  dsh()
    .rollbackDrain(params || {})
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
);

ipcMain.handle("dsh:providerCatalog", () => dsh().providerCatalog());

ipcMain.handle("skill:list", () => dsh().skillList());

ipcMain.handle("skill:get", (event, name) => dsh().skillGet(name));
ipcMain.handle("mtnodeAgentSkill:index", () => dsh().mtnodeAgentSkillIndex());
ipcMain.handle("mtnodeAgentSkill:get", (event, name) => dsh().mtnodeAgentSkillGet(name));

ipcMain.handle("skill:add", (event, skill) => dsh().skillAdd(skill));

ipcMain.handle("skill:remove", (event, name) => dsh().skillRemove(name));

/* ---------------- MTNode 讨论区（UI 为可下载窗口插件，宿主 IPC 仍在此） ---------------- */
const FORUM_IMG_MAX = 1080;
const FORUM_IMG_BYTES = 3 * 1024 * 1024;

function forumDir() {
  return mk(join(DATA(), "forum"));
}
function forumLocalPath() {
  return join(forumDir(), "messages.json");
}
function forumCachePath(id) {
  const sid = String(id || "").replace(/[^\w.-]/g, "_");
  return join(mk(join(forumDir(), "img")), sid + ".jpg");
}
function compressForumJpeg(raw) {
  if (!raw || !raw.length) return { ok: false, error: I18n.t("无法读取该文件路径") };
  if (raw.length > 20 * 1024 * 1024) return { ok: false, error: I18n.t("图片过大") };
  let img;
  try {
    img = nativeImage.createFromBuffer(raw);
  } catch {
    return { ok: false, error: I18n.t("无法读取该文件路径") };
  }
  if (!img || img.isEmpty()) return { ok: false, error: I18n.t("无法读取该文件路径") };
  const sz = img.getSize();
  const maxSide = Math.max(sz.width || 0, sz.height || 0);
  if (maxSide > FORUM_IMG_MAX) {
    const scale = FORUM_IMG_MAX / maxSide;
    img = img.resize({
      width: Math.max(1, Math.round((sz.width || 1) * scale)),
      height: Math.max(1, Math.round((sz.height || 1) * scale)),
    });
  }
  let jpg = img.toJPEG(82);
  if (jpg.length > FORUM_IMG_BYTES) jpg = img.toJPEG(70);
  if (jpg.length > FORUM_IMG_BYTES) jpg = img.toJPEG(55);
  if (jpg.length > FORUM_IMG_BYTES) return { ok: false, error: I18n.t("图片过大") };
  const out = nativeImage.createFromBuffer(jpg);
  const osz = out && !out.isEmpty() ? out.getSize() : sz;
  return {
    ok: true,
    base64: jpg.toString("base64"),
    mime: "image/jpeg",
    bytes: jpg.length,
    width: osz.width,
    height: osz.height,
  };
}
ipcMain.handle("forum:open", () => openWindowPlugin("forum"));
ipcMain.handle("forum:close", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) {
    try { w.close(); } catch {}
  }
  return { ok: true };
});
ipcMain.handle("forum:getAuth", () => {
  /* 登录态统一来自 auth-store（与顶栏 / 商店同源）；config.storeAuth 已废弃。 */
  const cfg = readJson(join(DATA(), "config.json"), {}) || {};
  const st = authStore.state();
  return {
    ok: true,
    signedIn: !!st.loggedIn,
    user: st.user || null,
    locale: cfg.locale === "en" ? "en" : "zh",
  };
});
ipcMain.handle("forum:setAuth", () => {
  /* 兼容旧调用：会话不再写 config.json（避免两份 token 打架），登录态走 auth:* 通道。 */
  return { ok: true, deprecated: true };
});
ipcMain.handle("forum:localLoad", () => {
  try {
    const data = readJson(forumLocalPath(), { rooms: { general: [], bug: [], improve: [] } });
    const rooms = (data && data.rooms) || {};
    const lastRead = (data && data.lastRead) || {};
    const out = {
      rooms: { general: [], bug: [], improve: [] },
      lastRead: { general: 0, bug: 0, improve: 0 },
    };
    for (const key of ["general", "bug", "improve"]) {
      const arr = Array.isArray(rooms[key]) ? rooms[key] : [];
      out.rooms[key] = arr.slice(-500);
      out.lastRead[key] = Number(lastRead[key] || 0) || 0;
    }
    return { ok: true, data: out };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:localSave", (e, data) => {
  try {
    const rooms = (data && data.rooms) || {};
    const lastRead = (data && data.lastRead) || {};
    const clean = {
      rooms: { general: [], bug: [], improve: [] },
      lastRead: { general: 0, bug: 0, improve: 0 },
    };
    for (const key of ["general", "bug", "improve"]) {
      const arr = Array.isArray(rooms[key]) ? rooms[key] : [];
      clean.rooms[key] = arr.slice(-500).map((m) => ({
        id: String((m && m.id) || ""),
        room: key,
        text: String((m && m.text) || "").slice(0, 2000),
        imageId: String((m && m.imageId) || ""),
        createdAt: Number((m && m.createdAt) || 0) || 0,
        user: m && m.user
          ? {
              id: String(m.user.id || ""),
              username: String(m.user.username || "").slice(0, 32),
              nickname: String(m.user.nickname || "").slice(0, 32),
            }
          : { id: "", username: "", nickname: "" },
      })).filter((m) => m.id);
      clean.lastRead[key] = Number(lastRead[key] || 0) || 0;
    }
    writeJson(forumLocalPath(), clean);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:cacheImage", (e, opts) => {
  try {
    const id = String((opts && opts.id) || "");
    const b64 = String((opts && opts.base64) || "");
    if (!id || !b64) return { ok: false };
    fs.writeFileSync(forumCachePath(id), Buffer.from(b64, "base64"));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:readCachedImage", (e, id) => {
  try {
    const fp = forumCachePath(id);
    if (!fs.existsSync(fp)) return { ok: false };
    const buf = fs.readFileSync(fp);
    return { ok: true, dataUrl: "data:image/jpeg;base64," + buf.toString("base64") };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:compressImage", (e, opts) => {
  try {
    const raw = Buffer.from(String((opts && opts.base64) || ""), "base64");
    return compressForumJpeg(raw);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("forum:pickImage", async (e) => {
  try {
    const parent = BrowserWindow.fromWebContents(e.sender) || win();
    const r = await dialog.showOpenDialog(parent, {
      title: I18n.t("选择图像"),
      properties: ["openFile"],
      filters: [{ name: I18n.t("图像"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: "cancelled" };
    const raw = fs.readFileSync(r.filePaths[0]);
    return compressForumJpeg(raw);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------------- 窗口 ---------------- */

app.whenReady().then(() => {
  /* 隐藏原生窗口菜单栏（File/Edit/View/Window/Help），按键快捷方式由渲染层自行处理 */
  Menu.setApplicationMenu(null);
  migrateLegacyWorkflows();
  migrateLegacyStoreAuth();
  /* 画布备份：启动片刻后先做一次基线（无改动的后续 tick 自动跳过），之后每 5 分钟一次 */
  setTimeout(workflowBackupTick, 5000);
  setInterval(workflowBackupTick, WF_BACKUP_MS);
  applyMainLocale(localeFromDisk());
  crashReport.installAppHandlers();
  /* dsh 网关随应用启动(幂等,失败不阻塞应用;引擎自愈见 main-dsh.js) */
  dsh().ensureStarted().catch(() => {});
  mainWin = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: I18n.t("MTNode AI编排器 · MTNode AI Orchestrator"),
    icon: join(__dirname, "build", "icon.png"),
    backgroundColor: "#0d1016",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      preload: join(__dirname, "preload.js"),
    },
  });
  mainWin.loadFile(join(__dirname, "renderer", "index.html"));
  /* 应用目录零数据：启动只读体检（违规即记日志 + 弹窗报警，不静默写入） */
  try { auditAppDirData(); } catch (err) { console.warn("[appdir-audit] 体检失败：" + ((err && err.message) || err)); }
  /* 禁止主窗被链接导航走；改为嵌套 modal 对话框打开 */
  mainWin.webContents.on("will-navigate", (ev, url) => {
    const cur = mainWin.webContents.getURL();
    if (url && url !== cur) {
      ev.preventDefault();
      if (/^https?:\/\//i.test(url) || /^file:/i.test(url)) {
        openContentViewDialog({
          parent: mainWin,
          url,
          title: url,
        });
      }
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || "");
    if (/^https?:\/\//i.test(u) || /^file:/i.test(u)) {
      openContentViewDialog({ parent: mainWin, url: u, title: u });
    } else if (/^mailto:/i.test(u)) {
      try {
        shell.openExternal(u);
      } catch {}
    }
    return { action: "deny" };
  });
  mainWin.on("closed", () => {
    closeContentViewWin();
    mainWin = null;
    try { shutdownAppPlugins(); } catch {}
  });
  /* 主窗渲染层没了 → 它发起的运行也不存在了，回收全部宿主外部进程（函数节点绑定进程随之消失） */
  mainWin.webContents.once("destroyed", () => {
    /* 渲染层没了 → 活跃函数运行再没人收结果：终止线程 + 回收其进程 */
    try { if (fnRuntime) fnRuntime.shutdown().catch(() => {}); } catch {}
    procHost.killAll().catch(() => {});
  });
  registerUpdateIpc(() => mainWin);
  registerPetIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
  });
  registerAppPluginsIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getAppVersion: () => app.getVersion(),
  });
  /* Music3 / H3 后端不随 MTNode 退出；此处只注册 IPC / 控制台窗 */
  registerMusic3Ipc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerH3Ipc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerLlamaIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerTtsIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  registerRemotionIpc({
    getDataDir: DATA,
    getMainWin: () => mainWin,
    appRoot: __dirname,
    getDsh: () => dsh(),
  });
  /* 回滚存储：内容寻址对象 + 轮次账本 + GC（渲染层无 fs，字节读写只走这里） */
  registerRollbackIpc({ getDataDir: DATA, t: (s) => I18n.t(s) });
  /* 工具库：跨画布可复用工具包（<数据目录>/tools/*.json 完整工具包落盘） */
  registerToolsIpc({ getDataDir: DATA, t: (s) => I18n.t(s) });
  /* 素材库：独立于画布的文本/图像/音频/视频内容仓库（用户指定根目录，见 assets-store.js） */
  registerAssetsIpc({ getDataDir: DATA, t: (s) => I18n.t(s) });
  mainWin.webContents.once("did-finish-load", () => {
    startBackgroundCheck(() => mainWin);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

  /* 退出时关闭 dsh 网关与全部运行时子进程，避免遗留孤儿进程。
   Music3 / H3 后端故意不杀（单例、独立于 MTNode 生命周期）。 */
app.on("before-quit", () => {
  /* 函数节点运行线程：先终止 worker 再扫进程树 —— 节点不在运行态就不该有线程/进程 */
  try { if (fnRuntime) fnRuntime.shutdown().catch(() => {}); } catch {}
  /* 宿主外部进程（函数节点运行期拉起）：退出即全部回收，不留残留进程/控制台 */
  try { procHost.killAll().catch(() => {}); } catch {}
  try { shutdownPet(); } catch {}
  try { shutdownAppPlugins(); } catch {}
  try { shutdownMusic3UiOnly(); } catch {}
  try { shutdownH3UiOnly(); } catch {}
  try { shutdownLlamaUiOnly(); } catch {}
  try { shutdownTtsUiOnly(); } catch {}
  try { shutdownRemotionUiOnly(); } catch {}
  if (dshAdapter) {
    try { dshAdapter.shutdown(); } catch {}
  }
});
/* will-quit 兜底：before-quit 阶段若有运行仍在起进程，这里再收一次 */
app.on("will-quit", () => {
  /* 函数节点运行线程：先终止 worker 再扫进程树 —— 节点不在运行态就不该有线程/进程 */
  try { if (fnRuntime) fnRuntime.shutdown().catch(() => {}); } catch {}
  try { procHost.killAll().catch(() => {}); } catch {}
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    app.emit("ready");
  }
});

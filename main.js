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
} = require("electron");
const path = require("path");
const fs = require("fs");
const { launchDetached } = require("./main-exec-launch.js");
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
const { patchProviders } = require("./config-providers.js");
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
const assetDir = (wfId) => mk(join(DATA(), "assets", String(wfId)));

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
ipcMain.handle("workflow:delete", (e, id) => {
  if (!wfIdOk(id)) return { ok: false };
  try {
    fs.rmSync(wfPath(id));
  } catch {}
  try {
    fs.rmSync(assetDir(id), { recursive: true, force: true });
  } catch {}
  return { ok: true };
});

/* ---------------- IPC：Zen 沉浸式存档 ---------------- */

const zenIdOk = (id) => /^[A-Za-z0-9_-]{4,120}$/.test(String(id || ""));
const zenPath = (id) => join(DATA(), "zen", String(id) + ".json");
const zenBackupDir = (id) => join(DATA(), "zen-backups", String(id));

ipcMain.handle("zen:list", () => {
  const d = mk(join(DATA(), "zen"));
  let files = [];
  try {
    files = fs.readdirSync(d);
  } catch {}
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const j = readJson(join(d, f), {});
      const id = j.id || f.slice(0, -5);
      let mtime = 0;
      try {
        mtime = fs.statSync(join(d, f)).mtimeMs;
      } catch {}
      return {
        id,
        name: j.name || id,
        mtime,
        nodes: (j.nodes || []).length,
        phase: j.phase || "explore",
        workflowId: j.workflowId || "",
        projectFolder: j.projectFolder || "",
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle("zen:load", (e, id) => {
  if (!zenIdOk(id)) return { ok: false, error: I18n.t("非法存档 id") };
  const j = readJson(zenPath(id));
  return j ? { ok: true, data: j } : { ok: false, error: I18n.t("存档不存在") };
});

ipcMain.handle("zen:create", (e, { name }) => {
  const id = "zen_" + Date.now().toString(36);
  const now = Date.now();
  const doc = {
    id,
    name: String(name || "").trim() || "Zen",
    createdAt: now,
    updatedAt: now,
    projectFolder: "",
    workflowId: "",
    cam: { x: 0, y: 0, z: 1 },
    nodes: [],
    edges: [],
    chat: [],
    planMarkdown: "",
    phase: "explore",
    activeNodeIds: [],
  };
  writeJson(zenPath(id), doc);
  return { ok: true, id, data: doc };
});

ipcMain.handle("zen:save", (e, { id, data }) => {
  if (!zenIdOk(id)) return { ok: false, error: I18n.t("非法存档 id") };
  const j = data || {};
  j.id = id;
  j.updatedAt = Date.now();
  writeJson(zenPath(id), j);
  return { ok: true, mtime: Date.now() };
});

ipcMain.handle("zen:delete", (e, id) => {
  if (!zenIdOk(id)) return { ok: false };
  try {
    fs.rmSync(zenPath(id));
  } catch {}
  try {
    fs.rmSync(zenBackupDir(id), { recursive: true, force: true });
  } catch {}
  return { ok: true };
});

ipcMain.handle("zen:backup", (e, id) => {
  if (!zenIdOk(id)) return { ok: false, error: I18n.t("非法存档 id") };
  try {
    const src = zenPath(id);
    if (!fs.existsSync(src)) return { ok: false, error: I18n.t("存档不存在") };
    const bakDir = mk(zenBackupDir(id));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(src, join(bakDir, "zen-" + stamp + ".json"));
    /* FIFO：最多保留 3 份 */
    const files = fs
      .readdirSync(bakDir)
      .filter((f) => f.startsWith("zen-") && f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(join(bakDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(3)) {
      try {
        fs.unlinkSync(join(bakDir, old.f));
      } catch {}
    }
    return { ok: true, mtime: Date.now() };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("zen:listBackups", (e, id) => {
  if (!zenIdOk(id)) return { ok: false, error: I18n.t("非法存档 id") };
  try {
    const bakDir = zenBackupDir(id);
    if (!fs.existsSync(bakDir)) return { ok: true, list: [] };
    return {
      ok: true,
      list: fs
        .readdirSync(bakDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          let t = 0;
          try {
            t = fs.statSync(join(bakDir, f)).mtimeMs;
          } catch {}
          return { file: f, mtime: t };
        })
        .sort((a, b) => b.mtime - a.mtime),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("zen:restoreBackup", (e, { id, file }) => {
  if (!zenIdOk(id)) return { ok: false, error: I18n.t("非法存档 id") };
  const fname = String(file || "").replace(/[^A-Za-z0-9_.-]/g, "");
  if (!fname.endsWith(".json"))
    return { ok: false, error: I18n.t("非法备份文件") };
  const j = readJson(join(zenBackupDir(id), fname));
  if (!j) return { ok: false, error: I18n.t("备份不存在") };
  j.updatedAt = Date.now();
  writeJson(zenPath(id), j);
  return { ok: true, data: j };
});

/* Zen 内置 skill 全文（渲染层按需注入系统提示；打包后在 asar 内读取） */
ipcMain.handle("zen:skillText", (e, id) => {
  const safe = String(id || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (!safe) return { ok: false, error: I18n.t("非法技能 id") };
  const p = join(__dirname, "mtnode-agent-skills", "zen", safe, "SKILL.md");
  try {
    if (!fs.existsSync(p)) return { ok: false, error: I18n.t("技能不存在") };
    return { ok: true, text: fs.readFileSync(p, "utf8") };
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
ipcMain.handle("shell:openExternal", (e, url) => {
  if (typeof url === "string" && /^(https?:\/\/|mailto:)/i.test(url))
    shell.openExternal(url);
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
  process.env.MTNODE_STORE_URL || "http://mt-agent.com/mtnode/store-api";

ipcMain.handle("store:request", async (e, opts) => {
  try {
    const o = opts || {};
    const p = String(o.path || "");
    if (!p.startsWith("/")) return { ok: false, error: I18n.t("非法 URL") };
    const method = String(o.method || "GET").toUpperCase();
    const headers = {
      Accept: "*/*",
      "User-Agent": "MTNodeAIO/1.1",
    };
    if (o.token) headers.Authorization = "Bearer " + String(o.token);
    let body;
    if (o.json != null) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    }
    const res = await fetch(STORE_BASE + p, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(120000),
    });
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
   超时覆盖整个请求（含响应体读取）。 */
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(I18n.t("请求超时"))));
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(I18n.t("下载图像超时"))));
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

/* 读取参考图并缩放到不超过 API_REF_IMAGE_MAX_DIM（等比）后再发 API。无法解码或已达标时原样返回。 */
function shrinkImageForApi(p) {
  const raw = fs.readFileSync(p);
  const ext = String(path.extname(p)).slice(1).toLowerCase() || "png";
  return shrinkImageBuffer(raw, ext, API_REF_IMAGE_MAX_DIM);
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

/* 构建完整请求描述（预览与真实调用共用，保证一致） */
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
    const sz = GPT_IMAGE_SIZES.includes(size) ? size : "2048x1360";
    if (images && images.length) {
      /* 带参考图：/images/edits multipart，多图按顺序 = prompt 中的图1/图2/… */
      return {
        method: "POST",
        url: base + "/images/edits",
        headers: { Authorization: auth.Authorization },
        body: {
          __multipart: {
            model: model || "gpt-image-2-vip",
            prompt,
            size: sz,
            image: images.slice(),
          },
        },
      };
    }
    /* 文生图：/images/generations，不支持 n/quality/aspect_ratio */
    return {
      method: "POST",
      url: base + "/images/generations",
      headers: auth,
      body: {
        model: model || "gpt-image-2-vip",
        prompt,
        size: sz,
        response_format: "b64_json",
      },
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

/* multipart 表单请求：image 字段支持字符串（单张）或数组（多张参考图，顺序=图1/图2/…） */
async function sendMultipart(url, headers, form, timeoutMs = 180000, reqKey) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form || {})) {
    if (Array.isArray(v)) {
      let i = 1;
      for (const p of v) {
        if (!p) continue;
        const { buf, ext } = shrinkImageForApi(p);
        fd.append(k, new Blob([buf]), "ref" + i + "." + ext);
        i++;
      }
    } else if (k === "image" && typeof v === "string" && v) {
      const { buf, ext } = shrinkImageForApi(v);
      fd.append("image", new Blob([buf]), "ref." + ext);
    } else {
      fd.append(k, v);
    }
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
  );

  if (kind === "text" || provider.type === "image_mj") {
    const { status, j, text } = await fetchJson(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
      },
      undefined,
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
      const r = await fetchRaw(url, 60000, abKey);
      if (r.status >= 400) throw new Error(I18n.t("下载图像失败 HTTP ") + r.status);
      b64 = r.buf.toString("base64");
    }
    return { ok: true, base64: b64, ext: "png" };
  }

  if (provider.type === "image_openai") {
    let status, j, text;
    if (req.body && req.body.__multipart) {
      ({ status, j, text } = await sendMultipart(
        req.url,
        req.headers,
        req.body.__multipart,
        180000,
        abKey,
      ));
    } else {
      ({ status, j, text } = await fetchJson(
        req.url,
        {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(req.body),
        },
        undefined,
        abKey,
      ));
    }
    if (status >= 400) throw new Error(apiErr(status, j, text));
    const b64 = normB64(j && j.data && j.data[0] && j.data[0].b64_json);
    if (!b64) throw new Error(I18n.t("响应无图像数据"));
    return { ok: true, base64: b64, ext: "png" };
  }

  if (provider.type === "image_stability") {
    const { status, j, text } = await sendMultipart(
      req.url,
      req.headers,
      req.body.__multipart,
      180000,
      abKey,
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
    );
    const readable = JSON.parse(
      JSON.stringify(req.body, (k, v) => {
        if (k === "image" && Array.isArray(v))
          return v.map((x) => I18n.t("<参考图: ") + x + ">");
        if (k === "image" && typeof v === "string" && v && !v.startsWith("<"))
          return I18n.t("<参考图: ") + v + ">";
        return v;
      }),
    );
    return {
      ok: true,
      request: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: readable,
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
  const cfg = readJson(join(DATA(), "config.json"), {}) || {};
  return {
    ok: true,
    auth: cfg.storeAuth || null,
    locale: cfg.locale === "en" ? "en" : "zh",
  };
});
ipcMain.handle("forum:setAuth", (e, auth) => {
  const fp = join(DATA(), "config.json");
  const cfg = readJson(fp, {}) || {};
  cfg.storeAuth = auth || null;
  writeJson(fp, cfg);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("forum:authChanged", cfg.storeAuth);
  }
  return { ok: true };
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
  try { shutdownPet(); } catch {}
  try { shutdownAppPlugins(); } catch {}
  try { shutdownMusic3UiOnly(); } catch {}
  try { shutdownH3UiOnly(); } catch {}
  try { shutdownLlamaUiOnly(); } catch {}
  try { shutdownTtsUiOnly(); } catch {}
  if (dshAdapter) {
    try { dshAdapter.shutdown(); } catch {}
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    app.emit("ready");
  }
});

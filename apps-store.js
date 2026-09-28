"use strict";

/* ── 应用宿主（用户自建应用）· 主进程侧 ─────────────────────────────────────
 *
 * 「应用」= 用户 / 云端目录分发的本机小应用：一个文件夹一份，里面自带 index.html + assets，
 * 由 MTNode 开独立窗口（preload-app.js，桥 = window.appHost）跑起来；它自己的画布存成同目录的
 * <AppName>.mtnodes，整份应用可导出成 <AppName>.zip（**不含画布**）迁移 / 上架。
 *
 * 根目录（所有应用都装在它的下一层）：
 *   <root>/<id>/                     id = 文件夹名（app id 合法化见 safeAppId）
 *     app.json                       应用清单（可迁移：id / name / version / entry / description / icon）
 *     index.html                     入口页（zip 里带；缺失时补一份最小脚手架）
 *     assets/**                      应用自带资产（导出 zip 只带它 + app.json + index.html）
 *     storage/store.json             **该应用自己的本机存储**（appHost.storageGet / storageSet）
 *     <AppName>.mtnodes              该应用的画布（保存画布时写入；导出 zip 与更新安装都不碰它）
 *     <AppName>.zip                  导出的应用包（appHost 目录 = 用户搬家 / 上架用）
 *     installed.json                 本机安装账本（本次装进去的文件清单 / 来源 / sha256，**不导出**）
 *   <root>/                          .staging/ 为解包中转目录，装完即清
 *
 * 根目录设置（沿用 installDir 口径的键名，**写在本机 config.json，不写应用目录**）：
 *   <数据目录>/config.json → { "apps": { "installDir": "<绝对路径>" } }
 *   兼容读 appInstallDir / appsInstallDir / appsRoot（老写法 / 手改过的配置）；
 *   用户没指定时默认 <数据目录>/apps（默认落在 %APPDATA%，绝不落应用目录）。
 *   路径守卫（与 main.js isInsideAppDir 同口径）：解析结果等于或位于 app.getAppPath() /
 *   exe 同目录之下一律拒绝 —— 那里升级 / 卸载会带走或覆盖用户的应用。
 *
 * 云端目录与缓存：
 *   MTNODE_APPS_URL（默认 http://mt-agent.com/mtnode/apps）+ /catalog.json
 *   → { version, updatedAt, apps: [{ id, title, version, entry, zipUrl, sha256, icon, window, … }] }
 *   拉取成功缓存到 <数据目录>/apps-cache/catalog.json（云端挂了回退缓存，缓存也没有就空列表）。
 *   下载 zip → sha256 校验（目录声明了才校验）→ 解包到 .staging → 换进应用目录。
 *
 * 同名目录冲突 → **三态**：{ conflict:true, choices:["overwrite","rename","cancel"] }，
 * 由渲染层弹窗；覆盖 / 更新 = 只替换上次装进去的那批载荷（app.json / index.html / assets），
 * storage/ 与 <AppName>.mtnodes 等用户数据一律保留；改名 = 装成 <id>-2 / <id>-3 …
 *
 * 变更探测（apps:probeChanges）：按应用算「文件数 / 总字节 / 最新 mtime」快照并与上一份比对
 * （真相存在 <数据目录>/apps-cache/snapshot.json），供预览刷新与重打包使用。
 *
 * 独立窗口（apps:openWindow）：BrowserWindow + preload-app.js，loadFile 应用目录里的入口 HTML；
 *   外观认云端目录条目 window 的 width / height / minWidth / minHeight / frame / transparent /
 *   alwaysOnTop / skipTaskbar（缺省 = 普通可缩放窗口、居中、不置顶）；will-navigate 一律
 *   preventDefault（http(s) / mailto 交 shell.openExternal），新窗口一律 deny；随 MTNode 退出关闭。
 *
 * IPC（主窗口侧，preload.js 的 api.apps* 转发；本文件只注册通道，方法名见 registerAppsIpc）：
 *   apps:rootGet / rootSet / rootPick · apps:list · apps:create · apps:catalog · apps:install / uninstall
 *   apps:exportZip · apps:probeChanges · apps:openWindow / closeWindow / isOpen
 *   apps:devPreview（开发页预览：iframe url = mtnode-preview://<appId>/<entry> + 内容快照；
 *   该协议在本文件顶层登记为 standard/secure，响应给 HTML 注入页面状态小助手，
 *   供开发页重载预览时存 / 恢复滚动与表单值 —— 只有这一路注入，独立窗口不受影响）
 * 应用窗口侧（preload-app.js 的 window.appHost，**只暴露白名单四项能力**，无画布 / 无文件系统 /
 *   无账号 token / 无网络面）：文本生成 apps:hostText(Stream) · 图像生成 apps:hostImage ·
 *   本机存储 apps:hostStorage*（只在该应用自己的 storage/ 里读写）· 账号摘要 apps:hostAccount
 *   （已登录 + PublicUser 白名单字段）；另有 apps:closeWindow 关自己的窗口。
 * ─────────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const http = require("http");
const https = require("https");
const { app, BrowserWindow, ipcMain, dialog, shell, screen, protocol } = require("electron");
const { readJson, writeJson } = require("./config-providers.js");

/* ---------------- 常量 ---------------- */

const SCHEMA = 1;
/* app id = 文件夹名：只允许字母数字开头、字母数字与 . _ - ，2–64 位 */
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
/* Windows 保留名（大小写不敏感，含扩展名前的部分）不能做文件夹名 */
const WIN_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const FEED = (process.env.MTNODE_APPS_URL || "http://mt-agent.com/mtnode/apps").replace(/\/+$/, "");
const MAX_CATALOG = 512 * 1024;
const MAX_ZIP = 200 * 1024 * 1024;
const MAX_STORAGE = 2 * 1024 * 1024;
const STORAGE_KEY_MAX = 200;
const MAX_PROMPT = 100 * 1024;
const MAX_MESSAGES = 60;
const ENTRY_RE = /\.html?$/i;
const SUB = {
  manifest: "app.json",
  installed: "installed.json",
  index: "index.html",
  assets: "assets",
  storage: "storage",
  store: "store.json",
  staging: ".staging",
};
const CANVAS_EXT = ".mtnodes";
const ZIP_EXT = ".zip";
const DEFAULT_WINDOW = { width: 1200, height: 820, minWidth: 640, minHeight: 480 };

/* ---------------- 应用数据（默认数据根 + 每应用可改的数据文件夹） ----------------
 *
 * 应用窗口里的内容落盘不再写死进应用安装目录（<应用安装目录>/<id>/storage/store.json）：
 *   · 默认数据根 = <数据目录>/apps-data/<id>/           ← 与 config.json / save 同一层
 *   · 该应用的数据文件夹可改：指针存 <数据目录>/apps-data/<id>/dataDir.json
 *   · 写入白名单 = 默认数据根 + 用户**亲自选过**的那个文件夹；文件名取相对名，
 *     只允许落在白名单目录内的一层（相对名不得含分隔符与 ..），一律原子写（tmp+rename）。
 *   · 老数据首次读取时自动迁移（旧文件保留，不删）。
 *
 * 与「数据不落应用文件夹」同一口径：默认数据根、指针、data.json 全在数据目录下
 * （见 AGENTS.md 协作约定）；用户另选文件夹时是用户自己的选择，不在这里替他决定。 */
const DATA_ROOT_DIR = "apps-data";
const DATA_FILE = "data.json";
const DATA_DIR_POINTER = "dataDir.json";
/* 数据文件整份上限：与老的 storage 同量级（2MB），单次写入超限直接拒绝 */
const MAX_DATA_FILE = 2 * 1024 * 1024;
/* 关窗前等应用收尾回包的上限（毫秒）：到点直接关，绝不让一个卡住的页面把窗口钉住 */
const WILL_CLOSE_MS = 1500;
/* appHost 允许写的文件名白名单（见 normDataFileName） */
const DATA_FILE_NAMES = { "data.json": 1, "store.json": 1 };
const DATA_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/* 写入白名单：本次进程内用户选过的数据文件夹与会话应用数据根（小写比较，Windows 不敏感） */
const dataWriteAllow = new Set();

/* ---------------- 开发页预览（renderer/app-apps-dev.js） ----------------
   开发页用 iframe 实时预览应用目录里的静态页：url = mtnode-preview://<appId>/<entry>，
   相对资源同源解析（标准协议），所以应用页里的 ./app.js、assets/x.png 照常加载。
   响应里给 HTML 注入一段「页面状态小助手」，供开发页在重载预览前存、加载后写回
   （界面上的「维持状态」开关）；注入只发生在预览协议这一路，应用独立窗口
   （loadFile loadFile 的 apps:openWindow）逐字不变。
   协议必须在 app ready 之前登记为标准 / 安全协议 —— main.js 在本模块 require 期即完成，
   早于 whenReady。 */
const PREVIEW_SCHEME = "mtnode-preview";
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
} catch {}

const PREVIEW_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

/* 注入进预览页的状态小助手（与开发页用 postMessage 通信，跨源安全）：
   {op:'save',token} → 回 {op:'state',token,state}（滚动位置 + 表单值）；
   {op:'restore',state} → 写回。键名 __mtnodePreview 只为不撞应用自己的消息。 */
const PREVIEW_AGENT = [
  "(function(){",
  "if (window.__mtnodePreviewAgent) return; window.__mtnodePreviewAgent = 1;",
  "var K = '__mtnodePreview';",
  "function key(el){ if(el.id) return '#'+el.id; var n=el.getAttribute&&el.getAttribute('name'); if(n) return el.tagName.toLowerCase()+'[name=\"'+n+'\"]'; return ''; }",
  "function snap(){ var f=[]; try{ Array.prototype.forEach.call(document.querySelectorAll('input,textarea,select'),function(el){ var k=key(el); if(!k) return; f.push([k,(el.type==='checkbox'||el.type==='radio')?(el.checked?1:0):String(el.value==null?'':el.value)]); }); }catch(e){} return { x: window.scrollX||0, y: window.scrollY||0, fields: f }; }",
  "function apply(s){ if(!s) return; try{ var a=s.fields||[]; for(var i=0;i<a.length;i++){ var el=null; try{ el=document.querySelector(a[i][0]); }catch(e){} if(!el) continue; if(el.type==='checkbox'||el.type==='radio') el.checked=!!a[i][1]; else el.value=a[i][1]; } window.scrollTo(s.x||0, s.y||0); }catch(e){} }",
  "window.addEventListener('message', function(ev){ var d=ev.data||{}; if(!d || d[K]!==1) return;",
  "if(d.op==='save'){ var out={}; out[K]=1; out.op='state'; out.token=d.token; out.state=snap(); try{ ev.source.postMessage(out,'*'); }catch(e){} }",
  "else if(d.op==='restore'){ apply(d.state); }",
  "});",
  "})();",
].join("\n");

/* HTML 响应注入小助手：有 </body> 插在它前面，否则兜底追加在末尾 */
function injectPreviewAgent(html) {
  const src = String(html || "");
  const tag =
    '<script data-mtnode-preview-agent="1">' + PREVIEW_AGENT + "</scr" + "ipt>";
  if (/<\/body>/i.test(src)) return src.replace(/<\/body>/i, tag + "</body>");
  if (/<\/html>/i.test(src)) return src.replace(/<\/html>/i, tag + "</html>");
  return src + tag;
}

/* 请求是不是「页面导航」（地址栏 / iframe 首帧那种）：
   Accept 带 text/html 或 Sec-Fetch-Dest: document。资源请求（app.js / x.png）
   一律不算 —— 缺了资源要照常回 404，不能让页面悄悄变成另一份 HTML。 */
function previewWantsHtml(req) {
  try {
    const h = (req && typeof req.headers && req.headers.get) ? req.headers : null;
    if (!h) return false;
    const dest = String(h.get("sec-fetch-dest") || "").toLowerCase();
    if (dest === "document" || dest === "iframe") return true;
    if (dest) return false;
    return /text\/html/i.test(String(h.get("accept") || ""));
  } catch (_) {
    return false;
  }
}
/* 导航到不存在的文件时的兜底页（挂在默认入口页 index.html 那段之后）：
   顶部一条可读提示说明缺了什么、看的是哪一页，下面照常是入口页 —— 既不白底也不裸 404 */
function previewFallbackBanner(rel, fallbackRel) {
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[<>&"]/g, (c) => {
      return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
    });
  const a = esc(rel);
  const b = esc(fallbackRel);
  return [
    '<div data-mtnode-preview-fallback="1" style="margin:0;padding:9px 14px;background:#3a2c14;color:#ffe6b0;font:12px/1.6 system-ui,\'Microsoft YaHei\',sans-serif;border-bottom:1px solid #6b531f;word-break:break-all">',
    "预览兜底：入口页 " + (a ? "<code>" + a + "</code>" : "（未声明）") +
      " 读不到，已改显示默认入口页 <code>" + b + "</code>。在应用目录里把该文件补回来（或改 app.json 的 entry）即可。",
    "</div>",
  ].join("");
}
function previewFallbackHtml(html, rel, fallbackRel) {
  const src = String(html || "");
  const tag = previewFallbackBanner(rel, fallbackRel);
  if (/<body[^>]*>/i.test(src)) return src.replace(/<body[^>]*>/i, (m) => m + tag);
  return tag + src;
}
/* 导航请求找不到文件时的最终回执（连默认入口页都没有）：可读文本，不是裸 404 */
function previewNotFoundText(rel) {
  return [
    t("找不到文件") + "：" + String(rel || SUB.index),
    "",
    t("应用目录里没有这个文件（连默认入口页 index.html 都没有）："),
    t("在应用中心「开发」页的会话里说一句话让它建起来，或在应用目录里补上这个文件。"),
  ].join("\n");
}
/* 读一条预览响应（registerPreviewProtocol 与导航兜底共用）。命中链只在「导航请求」上走：
   请求的文件 → app.json 声明的入口页 → 默认 index.html ——
   app.json 缺 entry 或入口页被删，预览也始终落到应用的默认界面。
   资源请求（app.js / x.png）只认它自己那一个文件，缺了照常 404 ——
   绝不能把一份 HTML 塞给 <script src> 或 <img src>（页面会悄悄变成另一份 HTML）。
   HTML 一律注入页面状态小助手（刷新预览的「维持状态」靠它）。 */
function previewFileResponse(dir, rel, req) {
  const man = manifestOf(dir, path.basename(dir));
  const entry = safeEntry(man && man.entry) || SUB.index;
  const chain = [];
  if (rel) chain.push(rel);
  if (previewWantsHtml(req)) {
    if (entry) chain.push(entry);
    if (chain.indexOf(SUB.index) < 0) chain.push(SUB.index);
  }
  for (const p of chain) {
    const abs = resolveInside(dir, p);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const type = PREVIEW_MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
    /* no-store：预览看的必须是磁盘上的最新一版，绝不吃浏览器缓存
       （改完代码重载却看到旧版 app.js 就是从这里来的） */
    const headers = { "content-type": type, "cache-control": "no-store" };
    if (ENTRY_RE.test(abs)) {
      let html = fs.readFileSync(abs, "utf8");
      /* 走到备用页（不是请求的那一页）= 请求的入口页缺失：顶上挂一条可读提示 */
      if (p !== rel) html = previewFallbackHtml(html, rel, p);
      return new Response(injectPreviewAgent(html), { headers: headers });
    }
    return new Response(fs.readFileSync(abs), { headers: headers });
  }
  return null;
}

let previewProtocolReady = false;
/* 注册预览协议（幂等；registerAppsIpc 里调一次） */
function registerPreviewProtocol() {
  if (previewProtocolReady) return;
  previewProtocolReady = true;
  protocol.handle(PREVIEW_SCHEME, async (req) => {
    const plain = (msg, status) =>
      new Response(String(msg), {
        status: status,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    try {
      const u = new URL(String((req && req.url) || ""));
      /* URL 的 host 会被规范成小写，所以按大小写不敏感找目录 */
      const dir = previewDirOf(decodeURIComponent(String(u.hostname || "")));
      if (!dir) return plain(t("应用目录不存在"), 404);
      const rel = decodeURIComponent(String(u.pathname || "")).replace(/^\/+/, "");
      /* 一次读文件：请求的那一页不在时，按 app.json 入口页 → 默认 index.html 兜底，
         预览始终落到应用的默认界面（详细口径见 previewFileResponse） */
      const hit = previewFileResponse(dir, rel, req);
      if (hit) return hit;
      /* 兜底链走完都没有：导航请求回「入口页 + 一条可读提示」，资源请求照常 404 */
      const man = manifestOf(dir, path.basename(dir));
      const entry = safeEntry(man && man.entry) || SUB.index;
      if (previewWantsHtml(req)) {
        const abs = resolveInside(dir, entry);
        if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const html = previewFallbackHtml(
            fs.readFileSync(abs, "utf8"),
            rel && rel !== entry ? rel : "",
            entry,
          );
          return new Response(injectPreviewAgent(html), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        }
        return plain(previewNotFoundText(rel), 404);
      }
      return plain(t("找不到文件"), 404);
    } catch (err) {
      return plain(t("预览读取失败"), 500);
    }
  });
}

/* ---------------- 注入的宿主依赖 ---------------- */

let getDataDir = () => "";
let getMainWin = () => null;
let getAppVersion = () => "";
let t = (s) => String(s == null ? "" : s);
let authState = () => ({ ok: true, loggedIn: false, user: null, encryption: "plain", warning: "" });
let aiCall = null;
let aiCallStream = null;

/* ---------------- 通用小工具 ---------------- */

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function bad(msg, reason) {
  return { ok: false, reason: String(reason || ""), error: String(msg || "") };
}
function fail(err) {
  return { ok: false, error: String((err && err.message) || err) };
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function rmDirRecursive(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
function copyDirRecursive(src, dest) {
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}
/* 目录内全部文件的相对路径（"/" 分隔），跳过 .staging */
function walkFiles(dir, prefix, out) {
  const list = out || [];
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return list;
  }
  for (const ent of ents) {
    if (ent.name === SUB.staging) continue;
    const abs = path.join(dir, ent.name);
    const rel = prefix ? prefix + "/" + ent.name : ent.name;
    if (ent.isDirectory()) walkFiles(abs, rel, list);
    else if (ent.isFile()) list.push(rel);
  }
  return list;
}
/* 相对路径 → 基准目录内的绝对路径；绝对路径 / .. / 盘符一律拒绝（越界返回 ""） */
function resolveInside(baseDir, rel) {
  const raw = String(rel == null ? "" : rel).replace(/\\/g, "/");
  if (!raw || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return "";
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return "";
  const abs = path.resolve(path.join(baseDir, ...parts));
  const base = path.resolve(baseDir);
  if (abs !== base && !abs.startsWith(base + path.sep)) return "";
  return abs;
}
/* 单段名字净化 + <AppName> 口径（画布 / zip 文件名用它，改名不改画布） */
function safeBaseName(name, fb) {
  let v = String(name == null ? "" : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (v.length > 60) v = v.slice(0, 60).trim();
  if (!v || v === "." || v === "..") v = String(fb || "app");
  if (WIN_RESERVED.has(v.toLowerCase())) v = "_" + v;
  return v;
}
/* app id 合法化：只回合法的 id，非法回 ""（禁路径分隔符 / 保留名 / 首尾点） */
function safeAppId(v) {
  const s = String(v == null ? "" : v).trim();
  if (!APP_ID_RE.test(s)) return "";
  if (s.endsWith(".") || WIN_RESERVED.has(s.toLowerCase())) return "";
  return s;
}
function uniqueAppId(root, base) {
  const id = safeAppId(base) || "app";
  for (let i = 2; i < 200; i++) {
    const cand = id + "-" + i;
    if (!fs.existsSync(path.join(root, cand))) return cand;
  }
  return id + "-" + Date.now().toString(36);
}
function safeEntry(v) {
  const e = String(v == null ? "" : v).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!e || e.includes("..") || e.includes(":")) return "";
  if (!ENTRY_RE.test(e)) return "";
  return e;
}
/* 版本比较（同 plugins/main-app-plugins.js 口径） */
function verParts(s) {
  return String(s || "")
    .split(/[.\-+]/)
    .map((x) => parseInt(x, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}
function verCmp(a, b) {
  const x = verParts(a);
  const y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
function verGte(a, b) {
  return verCmp(a, b) >= 0;
}
function isDeepseekHost(baseUrl) {
  try {
    return new URL(String(baseUrl)).hostname.toLowerCase().includes("deepseek");
  } catch {
    return false;
  }
}

/* ---------------- 应用目录守卫（同 main.js isInsideAppDir：Windows 大小写不敏感）-------- */

function appDirs() {
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
}
function isInsideAppDir(p) {
  const target = path.resolve(String(p || ""));
  if (!target) return false;
  const cmp = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const tn = cmp(target);
  return appDirs().some((d) => {
    const b = cmp(d);
    return !!b && (tn === b || tn.startsWith(b + path.sep));
  });
}

/* ---------------- 根目录（config.json 的 apps.installDir） ---------------- */

const configPath = () => path.join(String(getDataDir() || ""), "config.json");
const cacheDir = () => mk(path.join(String(getDataDir() || ""), "apps-cache"));

function defaultRoot() {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("应用宿主未初始化（缺少数据目录）"));
  return path.join(d, "apps");
}
/* 只读：配置里记着的根目录（没配就回默认路径，configured=false 由渲染层走引导框） */
function rootPath() {
  const cfg = readJson(configPath(), {}) || {};
  const apps = isObj(cfg.apps) ? cfg.apps : {};
  const cands = [
    apps.installDir,
    cfg.appsInstallDir,
    cfg.appInstallDir,
    cfg.appsRoot,
  ];
  for (const v of cands) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && path.isAbsolute(s)) return { root: path.resolve(s), configured: true };
  }
  return { root: defaultRoot(), configured: false };
}
/* 校验一个候选根目录：绝对、非盘根、不在应用目录内（命中返回 bad，reason 见注释） */
function checkRoot(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return bad(t("请选择应用安装根目录"), "empty");
  if (!path.isAbsolute(s)) return bad(t("应用安装根目录必须是绝对路径"), "relative");
  const abs = path.resolve(s);
  if (abs === path.parse(abs).root) return bad(t("非法路径（磁盘根目录）"), "root");
  if (isInsideAppDir(abs)) return bad(t("应用安装根目录不能落在应用目录内"), "app");
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) return bad(t("该路径不是文件夹"), "notdir");
  return { ok: true, path: abs, reason: "", error: "" };
}
function setRoot(p) {
  const c = checkRoot(p);
  if (!c.ok) return c;
  const before = (() => {
    try {
      const r = rootPath();
      return r.configured ? r.root : "";
    } catch {
      return "";
    }
  })();
  mk(c.path);
  const cfg = readJson(configPath(), {}) || {};
  const apps = isObj(cfg.apps) ? Object.assign({}, cfg.apps) : {};
  apps.installDir = c.path; /* 键名沿用 installDir 口径；写在 config.json，不写应用目录 */
  writeJson(configPath(), Object.assign({}, cfg, { apps: apps }));
  return {
    ok: true,
    path: c.path,
    previous: before,
    changed: !!before && path.resolve(before) !== c.path,
    exists: fs.existsSync(c.path),
    defaultPath: (() => {
      try {
        return defaultRoot();
      } catch {
        return "";
      }
    })(),
  };
}
async function pickRoot() {
  const cur = (() => {
    try {
      return rootPath().root;
    } catch {
      return "";
    }
  })();
  const parent = getMainWin && getMainWin();
  const opts = {
    title: t("选择应用安装根目录"),
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cur || undefined,
  };
  const r = parent && !parent.isDestroyed()
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  return setRoot(r.filePaths[0]);
}

/* ---------------- 应用目录结构 ---------------- */

function appDirOf(root, id) {
  const sid = safeAppId(id);
  if (!sid) return "";
  const dir = path.resolve(path.join(root, sid));
  if (path.dirname(dir) !== path.resolve(root)) return "";
  return dir;
}
function manifestPath(dir) {
  return path.join(dir, SUB.manifest);
}
function installedPath(dir) {
  return path.join(dir, SUB.installed);
}
function storageFile(dir) {
  return path.join(dir, SUB.storage, SUB.store);
}

/* ---------------- 应用数据根 / 数据文件夹（见文件头常量段的说明） ---------------- */

function cmpPath(p) {
  const s = path.resolve(String(p || ""));
  return process.platform === "win32" ? s.toLowerCase() : s;
}
/* 默认数据根：<数据目录>/apps-data/<id>/（数据目录未就绪时抛错，由 guard 变成一句失败） */
function appDataRoot(id) {
  const sid = safeAppId(id);
  const d = String(getDataDir() || "").trim();
  if (!sid) throw new Error(t("应用 id 不合法"));
  if (!d) throw new Error(t("应用宿主未初始化（缺少数据目录）"));
  return path.join(d, DATA_ROOT_DIR, sid);
}
/* 数据文件夹指针：<数据目录>/apps-data/<id>/dataDir.json
 *   { dir, relative, updatedAt } —— 用户选在默认数据根里面时记相对名（换机器 / 换数据目录仍认），
 *   选在外面时记绝对路径（只在本进程内有效，绝不因此把应用目录当数据目录用）。 */
function dataDirPointerFile(id) {
  return path.join(appDataRoot(id), DATA_DIR_POINTER);
}
function readDataDirPointer(id) {
  const j = readJson(dataDirPointerFile(id), null);
  if (!isObj(j)) return null;
  /* 相对名优先（根内目录换数据目录 / 换机器仍认）；只允许根内的**一层**，. / .. 与分隔符不算 */
  const rel = String(j.relative || "").trim();
  if (rel && rel !== "." && rel !== ".." && !/[\\/]/.test(rel)) {
    const abs = path.resolve(path.join(appDataRoot(id), rel));
    if (path.dirname(abs) === path.resolve(appDataRoot(id))) return { dir: abs, relative: true };
  }
  const d = String(j.dir || "").trim();
  if (d && path.isAbsolute(d)) {
    /* 绝对路径再来一道闸：落在应用目录里的一律不算（老配置被手改坏也不认） */
    const abs = path.resolve(d);
    if (!isInsideAppDir(abs) && abs !== path.parse(abs).root) return { dir: abs, relative: false };
  }
  return null;
}
/* 计算该应用的数据文件夹（不建目录；建目录只在真正要写盘的那几处做） */
function appDataDirOf(id) {
  const p = readDataDirPointer(id);
  return p ? p.dir : appDataRoot(id);
}
/* 记账用的相对名：默认数据根内 = 相对名（""=根本身），根外 = 绝对路径 */
function dataDirRecord(id, dir) {
  const root = path.resolve(appDataRoot(id));
  const abs = path.resolve(String(dir || ""));
  if (cmpPath(abs) === cmpPath(root)) return "";
  if (cmpPath(abs).startsWith(cmpPath(root) + path.sep)) {
    return path.relative(root, abs).split(path.sep).join("/");
  }
  return abs;
}
/* 写指针：用户亲自选完才调这里，同时把该目录记进本次进程的写入白名单 */
function writeDataDirPointer(id, dir) {
  const abs = path.resolve(String(dir || ""));
  if (!abs) return bad(t("请选择数据文件夹"), "empty");
  if (abs === path.parse(abs).root) return bad(t("非法路径（磁盘根目录）"), "root");
  if (isInsideAppDir(abs)) return bad(t("数据文件夹不能落在应用目录内"), "app");
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) return bad(t("该路径不是文件夹"), "notdir");
  mk(appDataRoot(id));
  const record = dataDirRecord(id, abs);
  writeJson(dataDirPointerFile(id), {
    schema: SCHEMA,
    /* dir = 绝对落点（就地解析用）；relative = 根内相对名（换数据目录 / 换机器仍认） */
    dir: abs,
    relative: record && !path.isAbsolute(record) ? record : "",
    updatedAt: Date.now(),
  });
  dataWriteAllow.add(cmpPath(abs));
  mk(abs);
  return { ok: true, id: id, dir: abs, def: false, root: appDataRoot(id) };
}
/* 默认数据根（不带指针）：给「恢复默认」用 */
function clearDataDirPointer(id) {
  const p = dataDirPointerFile(id);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
  return { ok: true, id: id, dir: appDataRoot(id), def: true, root: appDataRoot(id) };
}
/* 该应用当前的写入白名单：默认数据根 + 用户选过的目录 */
function dataAllowList(id) {
  const out = [path.resolve(appDataRoot(id))];
  const p = readDataDirPointer(id);
  if (p && p.dir) out.push(path.resolve(p.dir));
  for (const a of dataWriteAllow) out.push(a);
  const seen = new Set();
  return out.filter((d) => {
    const k = cmpPath(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
/* 文件名合法化：只允许白名单文件名 + 一层相对名（不许分隔符 / .. / 盘符） */
function normDataFileName(name) {
  const s = String(name == null || name === "" ? DATA_FILE : name).trim();
  if (!s || /[\\/]/.test(s) || s === "." || s === "..") return "";
  if (!DATA_FILE_NAME_RE.test(s)) return "";
  if (Object.prototype.hasOwnProperty.call(DATA_FILE_NAMES, s.toLowerCase())) return s.toLowerCase();
  return "";
}
/* 解析「应用要写的那个数据文件」：白名单里挑第一个已存在的目录，都没有就用数据文件夹 */
function resolveDataTarget(id, name) {
  const fname = normDataFileName(name);
  if (!fname) return null;
  const allow = dataAllowList(id);
  const explicit = readDataDirPointer(id);
  const dirs = explicit && explicit.dir ? [path.resolve(explicit.dir)].concat(allow) : allow;
  let dir = "";
  for (const d of dirs) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      dir = d;
      break;
    }
  }
  if (!dir) dir = explicit && explicit.dir ? path.resolve(explicit.dir) : allow[0];
  return { dir: dir, file: path.join(dir, fname), name: fname, allow: allow };
}
/* 读该应用的数据（data.json，缺了先看老 storage/store.json 并顺手迁移；都没有 = {}） */
function readAppData(id, name) {
  const target = resolveDataTarget(id, name);
  if (!target) return { ok: true, data: {}, file: "", migrated: false };
  let data = readJson(target.file, null);
  let migrated = false;
  if (data == null) {
    const legacy = migrateLegacyStorage(id);
    if (legacy && legacy.moved) {
      data = readJson(target.file, null);
      migrated = true;
    }
  }
  if (!isObj(data)) data = {};
  /* 一字不改地回整份 data.json（老 storage 的 { schema, updatedAt, kv } 结构由读取侧
     readKvOf 自己剥外层；这里不替应用做任何结构改写） */
  return { ok: true, data: data, file: target.file, migrated: migrated };
}
/* 老数据自动迁移：<应用安装目录>/<id>/storage/store.json → <默认数据根>/data.json（旧文件保留）。
 *  只在还没有 data.json 时才搬，且只用默认数据根（绝不动用户另选过的文件夹）。 */
function migrateLegacyStorage(id) {
  const { root, configured } = rootPath();
  if (!configured) return { ok: true, moved: false };
  const dir = appDirOf(root, id);
  if (!dir) return { ok: true, moved: false };
  const old = storageFile(dir);
  if (!fs.existsSync(old)) return { ok: true, moved: false };
  const rootDir = appDataRoot(id);
  const target = path.join(rootDir, DATA_FILE);
  if (fs.existsSync(target)) return { ok: true, moved: false };
  const data = readJson(old, null);
  if (!isObj(data)) return { ok: true, moved: false };
  try {
    mk(rootDir);
    writeJson(target, data);
  } catch (err) {
    return { ok: false, moved: false, error: String((err && err.message) || err) };
  }
  return { ok: true, moved: true, from: old, to: target };
}
/* 打开该应用的数据文件夹（不存在先建出来，否则资源管理器会报错） */
async function openAppDataDir(id) {
  const dir = appDataDirOf(id);
  try {
    mk(dir);
  } catch (err) {
    return fail(err);
  }
  try {
    const errText = await shell.openPath(dir);
    if (errText) return bad(t("无法打开文件夹：") + String(errText), "open_failed");
  } catch (err) {
    return fail(err);
  }
  return { ok: true, dir: dir };
}
/* 让用户给自己的应用挑一个数据文件夹（窗口里「数据文件夹」→ 选择…）。
 *  agent（无宿主窗口）或 q=false 时直接拒绝 —— 路径只能来自用户亲自选的那一次。 */
async function pickAppDataDir(id, opts) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const o = isObj(opts) ? opts : {};
  const host = getMainWin && getMainWin();
  if (!host || host.isDestroyed() || o.q === false) return bad(t("需要你先选择数据文件夹"), "need_pick");
  const cur = (() => {
    try {
      return appDataDirOf(sid);
    } catch {
      return "";
    }
  })();
  const dlg = {
    title: t("选择这个应用的数据文件夹"),
    properties: ["openDirectory", "createDirectory"],
    defaultPath: fs.existsSync(cur) ? cur : undefined,
  };
  /* 与 apps:rootPick 同一口径：认不出父窗口就不再挂父窗口（dialog 不能被销毁的窗口继承） */
  const r = await dialog.showOpenDialog(host, dlg);
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  return writeDataDirPointer(sid, r.filePaths[0]);
}
/* 读清单（坏档当没有，绝不因为一份脏 JSON 让整个列表打不开） */
function readManifest(dir) {
  const j = readJson(manifestPath(dir), null);
  return isObj(j) ? j : null;
}
function readInstalled(dir) {
  const j = readJson(installedPath(dir), null);
  return isObj(j) ? j : null;
}
/* app.json 的 title 可以是字符串，也可以是 {zh,en}（与云端目录词条同一口径）；
   窗口标题取它，缺了退回 name（再缺才用 id）。 */
function manifestTitle(j, fb) {
  const v = j && j.title;
  if (isObj(v)) return String(v.zh || v.en || "").trim() || String(fb || "");
  return String(v == null ? "" : v).trim() || String(fb || "");
}
function manifestOf(dir, id) {
  const j = readManifest(dir) || {};
  const name = String(j.name || "").trim() || id;
  return {
    schema: SCHEMA,
    id: String(j.id || id),
    name: name,
    title: manifestTitle(j, name),
    version: String(j.version || "0.0.0"),
    entry: safeEntry(j.entry) || SUB.index,
    description: String(j.description || ""),
    icon: String(j.icon || ""),
    author: String(j.author || ""),
    tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
    createdAt: Number(j.createdAt) || 0,
    updatedAt: Number(j.updatedAt) || 0,
  };
}
/* 该应用的画布 / 导出包落点：<AppName>.mtnodes / <AppName>.zip（名字跟着清单的 name 走） */
function canvasPathOf(dir, name) {
  return path.join(dir, safeBaseName(name, "app") + CANVAS_EXT);
}
function zipPathOf(dir, name) {
  return path.join(dir, safeBaseName(name, "app") + ZIP_EXT);
}
/* 一份可迁移的应用清单（install 账本单独放 installed.json，不混进来） */
function writeManifest(dir, spec, prevManifest) {
  const now = Date.now();
  const prev = isObj(prevManifest) ? prevManifest : {};
  /* 字段取「目录条目 → 包内清单」里第一个非空值：目录条目是上架方声明，包内清单是作者自述，
     两者都空才用兜底（id / 0.0.0）。 */
  const pick = (a, b, fb) => {
    const x = String(a == null ? "" : a).trim();
    if (x) return x;
    const y = String(b == null ? "" : b).trim();
    return y || String(fb || "");
  };
  const tagsSrc = Array.isArray(spec.tags) && spec.tags.length ? spec.tags : Array.isArray(prev.tags) ? prev.tags : [];
  /* title：目录条目 / 包内清单里的那份（字符串或 {zh,en}）原样留着，窗口标题读它 */
  const titleSrc = (() => {
    const a = spec.title;
    if (isObj(a) ? (a.zh || a.en) : String(a == null ? "" : a).trim()) return a;
    const b = prev.title;
    if (isObj(b) ? (b.zh || b.en) : String(b == null ? "" : b).trim()) return b;
    return "";
  })();
  const man = {
    schema: SCHEMA,
    id: pick(spec.id, prev.id, ""),
    name: pick(spec.name, prev.name, pick(spec.id, prev.id, "app")),
    title: titleSrc,
    version: pick(spec.version, prev.version, "0.0.0"),
    entry: safeEntry(pick(spec.entry, prev.entry, SUB.index)) || SUB.index,
    description: pick(spec.description, prev.description, ""),
    icon: pick(spec.icon, prev.icon, ""),
    author: pick(spec.author, prev.author, ""),
    tags: tagsSrc.map(String),
    createdAt: Number(prev.createdAt) || now,
    updatedAt: now,
  };
  writeJson(manifestPath(dir), man);
  return man;
}
/* 目录结构：assets/ + storage/ 齐活；入口页缺失时补一份最小脚手架（认 window.appHost） */
function ensureStructure(dir, man) {
  mk(path.join(dir, SUB.assets));
  mk(path.join(dir, SUB.storage));
  const entry = safeEntry(man && man.entry) || SUB.index;
  const entryAbs = resolveInside(dir, entry) || path.join(dir, SUB.index);
  if (!fs.existsSync(entryAbs)) fs.writeFileSync(entryAbs, defaultPageHtml(man), "utf8");
  return entryAbs;
}
/* 新应用的默认页（「Hello world」欢迎页）：随包模板 templates/app-default/index.html ——
   一个自包含的 Markdown 欢迎页（页内极小渲染器 + 中/英双块 + 自绘标题栏），
   只讲一件事：在应用中心「开发」页的会话栏里说一句话，这个页面就会变成你要的样子。
   模板里 {{APP_NAME}} = 应用标题（转义后替换）。模板读不到（老包 / 被裁剪）时退回
   下面那份最简占位页 —— 新建应用绝不能没有入口页。 */
const DEFAULT_PAGE_TPL = path.join(__dirname, "templates", "app-default", "index.html");
function pageEsc(s) {
  return String(s == null ? "" : s).replace(/[<>&"]/g, (c) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
  });
}
function defaultPageHtml(man) {
  const name = String((man && man.name) || (man && man.id) || "应用");
  try {
    const tpl = fs.readFileSync(DEFAULT_PAGE_TPL, "utf8");
    if (tpl.indexOf("{{APP_NAME}}") >= 0) return tpl.split("{{APP_NAME}}").join(pageEsc(name));
  } catch (_) {}
  return scaffoldHtml(man);
}
function scaffoldHtml(man) {
  const name = String((man && man.name) || (man && man.id) || "应用");
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="UTF-8">',
    "<title>" + name.replace(/[<>&]/g, "") + "</title>",
    "<style>html,body{margin:0;height:100%;background:#0d1016;color:#e6e9ef;font:14px/1.7 system-ui,'Microsoft YaHei',sans-serif}main{padding:28px 32px}h1{font-size:18px;margin:0 0 12px}code{background:#1a1f29;padding:1px 6px;border-radius:4px}</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>" + name.replace(/[<>&]/g, "") + "</h1>",
    "<p>这是应用入口页（index.html）的占位内容。把这里换成你的界面即可。</p>",
    "<p>宿主能力走 <code>window.appHost</code>：文本生成 <code>textGen / textGenStream</code>、图像生成 <code>imageGen</code>、本机存储 <code>storageGet / storageSet</code>、账号摘要 <code>account()</code>。</p>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
/* 目录内容快照（文件数 / 总字节 / 最新 mtime）：appSummary 与开发页预览共用同一口径 */
function dirStatOf(dir) {
  const files = walkFiles(dir, "", []);
  let bytes = 0;
  let mtimeMs = 0;
  for (const rel of files) {
    try {
      const st = fs.statSync(path.join(dir, rel.split("/").join(path.sep)));
      bytes += st.size || 0;
      if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
    } catch {}
  }
  return { files: files.length, bytes: bytes, mtimeMs: mtimeMs };
}
/* 目录 → 渲染层用的摘要（列表 / 冲突提示 / 变更探测共用同一份口径） */
function appSummary(root, id) {
  const dir = appDirOf(root, id);
  if (!dir || !fs.existsSync(dir)) return null;
  const man = manifestOf(dir, id);
  const led = readInstalled(dir) || {};
  const stat = dirStatOf(dir);
  const canvas = canvasPathOf(dir, man.name);
  const zip = zipPathOf(dir, man.name);
  return {
    id: id,
    name: man.name,
    version: man.version,
    entry: man.entry,
    description: man.description,
    dir: dir,
    index: resolveInside(dir, man.entry) || path.join(dir, SUB.index),
    assets: path.join(dir, SUB.assets),
    storage: path.join(dir, SUB.storage),
    canvas: canvas,
    canvasExists: fs.existsSync(canvas),
    zip: zip,
    zipExists: fs.existsSync(zip),
    files: stat.files,
    bytes: stat.bytes,
    mtimeMs: stat.mtimeMs,
    installedAt: Number(led.installedAt) || 0,
    source: String(led.source || ""),
    sha256: String(led.sha256 || ""),
    broken: !readManifest(dir),
  };
}
function listApps() {
  const { root, configured } = rootPath();
  const apps = [];
  if (fs.existsSync(root)) {
    let ents = [];
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {}
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const id = safeAppId(ent.name);
      if (!id) continue;
      const s = appSummary(root, id);
      if (s) apps.push(s);
    }
  }
  apps.sort((a, b) => (b.installedAt || b.mtimeMs) - (a.installedAt || a.mtimeMs));
  return { ok: true, root: root, configured: configured, exists: fs.existsSync(root), apps: apps, at: Date.now() };
}

/* ---------------- 本机新建应用（库页 / 开发页的「新建应用」入口） ----------------
 *
 * 「新建应用」= 用户填「标题 + 文件夹名」→ 本文件建目录与 app.json（ensureStructure 补
 * assets/ storage/ 与缺失的入口页）→ 渲染层用**既有 workflow:save** 建同名画布
 * （画布 id = 文件夹名，画布 json 里写 appId）→ 画布里建一个开发节点 → 打开并居中。
 *
 * 画布落在数据目录（<数据目录>/save/<id>.json，用户数据不落应用目录）；应用目录内那份
 * <AppName>.mtnodes 只是镜像 —— 每次 workflow:save 由主进程按画布上的 appId 顺手同步
 * （main.js 的 writeWorkflowJson 钩子 → 本文件的 mirrorAppCanvas），供整目录迁移使用。
 * 导出 zip 不含它（见 exportZip）。
 */

/* 画布 id 规则（与 main.js 的 wfIdOk 同一口径：/^[A-Za-z0-9_-]{4,120}$/）。
   「文件夹名 = 画布 id」是新建应用的前提：带点 / 空格 / 中文的名字过不了 workflow:save，
   这里先拦下并说清原因，别让用户在「建完目录但画布存不下」的半成品上收场。 */
const CANVAS_WF_ID_RE = /^[A-Za-z0-9_-]{4,120}$/;
function appIdForCanvas(v) {
  const id = safeAppId(v);
  if (!id || !CANVAS_WF_ID_RE.test(id)) return "";
  return id;
}
/* 新建应用：建 <root>/<id>/ + app.json（version 从 1.0.0 起）。同 id 已存在一律拒绝
   （不自动改名：用户在「文件夹名」里填的就是他想要的那个名字，静默改名比报错更难查）。 */
function createApp(arg) {
  const a = isObj(arg) ? arg : {};
  /* 标题先判空再净化 —— safeBaseName 对空串会回落 "app"，不先拦下就会建出一个
     名字叫 app 的应用 */
  const rawName = String(a.name == null ? "" : a.name).trim();
  if (!rawName) return bad(t("请填写应用标题"), "no_name");
  const name = safeBaseName(rawName, "app");
  const id = appIdForCanvas(a.id);
  if (!id)
    return bad(
      t("文件夹名不合法：") +
        t("4–64 位字母 / 数字 / 下划线 / 连字符，不能含点、空格或中文（它同时是这张画布的 id）"),
      "bad_id",
    );
  let root = "";
  try {
    root = rootPath().root;
  } catch (err) {
    return fail(err);
  }
  if (isInsideAppDir(root)) return bad(t("应用安装根目录不能落在应用目录内"), "app");
  const dir = appDirOf(root, id);
  if (!dir) return bad(t("应用 id 不合法"), "bad_id");
  if (fs.existsSync(dir)) return bad(t("该文件夹名已存在：") + id, "exists");
  try {
    mk(dir);
    const man = writeManifest(dir, { id: id, name: name, version: "1.0.0" }, null);
    ensureStructure(dir, man);
    /* 目录里真实存在的核心文件（相对路径，已去掉 storage/ 运行期数据）：
       新建流程用它填开发节点的 devFiles，不靠猜扩展名。 */
    const files = walkFiles(dir, "", []).filter(
      (rel) => rel.indexOf(SUB.storage + "/") !== 0,
    );
    return {
      ok: true,
      id: man.id,
      name: man.name,
      version: man.version,
      entry: man.entry,
      dir: dir,
      root: root,
      canvasPath: canvasPathOf(dir, man.name),
      coreFiles: files.slice(0, 10),
    };
  } catch (err) {
    return fail(err);
  }
}
/* 应用画布镜像：把画布 json 同步写进 <root>/<id>/<AppName>.mtnodes（数据目录那份是唯一真源，
   这份只供整目录搬走时不丢画布）。appId 认不出应用目录时静默跳过 —— 镜像失败绝不能
   让画布保存报错。落盘口径与数据目录那份一致（同一个 writeJson）。 */
function mirrorAppCanvas(id, obj) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  let dir = "";
  try {
    dir = appDirOf(rootPath().root, sid);
  } catch (err) {
    return fail(err);
  }
  if (!dir || !fs.existsSync(dir)) return { ok: true, skipped: "no_app" };
  const p = canvasPathOf(dir, manifestOf(dir, sid).name);
  try {
    writeJson(p, obj || {});
    return { ok: true, path: p };
  } catch (err) {
    return fail(err);
  }
}

/* ---------------- 云端目录（拉取 + 缓存） ---------------- */

function fetchBuffer(url, onProgress, maxBytes) {
  const cap = maxBytes || MAX_ZIP;
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("https") ? https : http;
    const req = lib.get(
      String(url),
      { headers: { "User-Agent": "MTNodeAIO/1.1-apps" }, timeout: 120000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchBuffer(res.headers.location, onProgress, cap).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        const total = Number(res.headers["content-length"]) || 0;
        if (total > cap) {
          res.resume();
          reject(new Error("too_large"));
          return;
        }
        const chunks = [];
        let got = 0;
        res.on("data", (c) => {
          got += c.length;
          if (got > cap) {
            req.destroy();
            reject(new Error("too_large"));
            return;
          }
          chunks.push(c);
          if (onProgress) onProgress({ got, total });
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

const catalogUrl = () => FEED + "/catalog.json";
const catalogCachePath = () => path.join(cacheDir(), "catalog.json");

/* 目录里的下载地址：只允许同源 http/https（云端目录改不了下载源，防投毒） */
function resolveZipUrl(zipUrl) {
  const u = String(zipUrl || "").trim();
  if (!u) return "";
  if (u.startsWith("/")) return FEED + u;
  if (!/^https?:\/\//i.test(u)) return FEED + "/" + u.replace(/^\.\//, "");
  try {
    const feed = new URL(FEED);
    const zip = new URL(u);
    if (zip.protocol !== "http:" && zip.protocol !== "https:") return "";
    if (zip.hostname.toLowerCase() !== feed.hostname.toLowerCase()) return "";
    return zip.toString();
  } catch {
    return "";
  }
}
function loc(v) {
  if (isObj(v)) {
    const zh = String(v.zh || v.en || "").trim();
    const en = String(v.en || v.zh || "").trim();
    return { zh: zh || en, en: en || zh };
  }
  const s = String(v == null ? "" : v).trim();
  return { zh: s, en: s };
}
/* 目录条目归一：认不出的条目（没有合法 id）直接丢，绝不让一条脏数据挡住整份目录 */
function normSpec(raw) {
  const s = isObj(raw) ? raw : {};
  const id = safeAppId(s.id);
  if (!id) return null;
  const title = loc(s.title || s.name);
  const min = String(s.minAppVersion || "").trim();
  return {
    id: id,
    title: title,
    name: title.zh || title.en || id,
    subtitle: loc(s.subtitle || s.description),
    description: String(s.description || "").trim(),
    author: String(s.author || "").trim(),
    tags: (Array.isArray(s.tags) ? s.tags : []).map(String).filter(Boolean),
    version: String(s.version || "0.0.0").trim(),
    minAppVersion: min,
    compatible: !min || verGte(String(getAppVersion() || "0.0.0"), min),
    entry: safeEntry(s.entry) || SUB.index,
    zipUrl: String(s.zipUrl || "").trim(),
    sha256: String(s.sha256 || "").trim().toLowerCase(),
    icon: String(s.icon || "").trim(),
    window: isObj(s.window) ? s.window : {},
  };
}
function parseCatalogDoc(doc) {
  const d = isObj(doc) ? doc : {};
  const list = Array.isArray(d.apps) ? d.apps : Array.isArray(d.list) ? d.list : [];
  const apps = [];
  for (const item of list) {
    const spec = normSpec(item);
    if (spec) apps.push(spec);
  }
  return { version: Number(d.version) || 1, updatedAt: String(d.updatedAt || ""), apps: apps };
}
/* 装上 / 可更新状态：目录条目 × 本机目录 */
function attachInstalled(specs) {
  const have = Object.create(null);
  for (const s of listApps().apps) if (s.id) have[s.id] = s;
  return (Array.isArray(specs) ? specs : []).map((spec) => {
    const cur = have[spec.id] || null;
    return Object.assign({}, spec, {
      installed: !!cur,
      installedVersion: cur ? cur.version : "",
      installedAt: cur ? cur.installedAt : 0,
      dir: cur ? cur.dir : "",
      updateAvailable: !!cur && verCmp(spec.version, cur.version) > 0,
    });
  });
}
async function fetchRemoteCatalog() {
  const buf = await fetchBuffer(catalogUrl(), null, MAX_CATALOG);
  const doc = JSON.parse(buf.toString("utf8"));
  if (!isObj(doc) || !(Array.isArray(doc.apps) || Array.isArray(doc.list))) throw new Error("bad_catalog");
  const parsed = parseCatalogDoc(doc);
  writeJson(catalogCachePath(), { fetchedAt: Date.now(), sourceUrl: catalogUrl(), doc: doc });
  return parsed;
}
/* 云端目录：拉不到就回退缓存，缓存也没有就空列表（绝不把「没网」当「目录是错的」抛给渲染层） */
async function loadCatalog() {
  try {
    const remote = await fetchRemoteCatalog();
    return {
      ok: true,
      source: "remote",
      fetchedAt: Date.now(),
      sourceUrl: catalogUrl(),
      apps: attachInstalled(remote.apps),
      appVersion: String(getAppVersion() || ""),
    };
  } catch (remoteErr) {
    const remoteError = String((remoteErr && remoteErr.message) || remoteErr);
    const c = readJson(catalogCachePath(), null);
    if (c && c.doc) {
      const parsed = parseCatalogDoc(c.doc);
      return {
        ok: true,
        source: "cache",
        fetchedAt: Number(c.fetchedAt) || 0,
        sourceUrl: String(c.sourceUrl || catalogUrl()),
        apps: attachInstalled(parsed.apps),
        appVersion: String(getAppVersion() || ""),
        remoteError: remoteError,
      };
    }
    return {
      ok: true,
      source: "empty",
      fetchedAt: 0,
      sourceUrl: catalogUrl(),
      apps: [],
      appVersion: String(getAppVersion() || ""),
      remoteError: remoteError,
    };
  }
}
/* 找一个目录条目：先缓存、再远端（安装时云端刚更新过也能装上） */
async function findSpec(id) {
  const c = readJson(catalogCachePath(), null);
  if (c && c.doc) {
    const hit = parseCatalogDoc(c.doc).apps.find((a) => a.id === id);
    if (hit) return hit;
  }
  const cat = await loadCatalog();
  return (cat.apps || []).find((a) => a.id === id) || null;
}

/* ---------------- zip：解包（安装）与打包（导出 zip） ---------------- */

function unzipBuffer(buf, destDir) {
  mk(destDir);
  let o = 0;
  while (o + 4 <= buf.length) {
    const sig = buf.readUInt32LE(o);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(o + 8);
    const compSize = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nameLen).toString("utf8");
    const dataStart = o + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw new Error("zip truncated");
    o = dataEnd;
    if (!name || name.endsWith("/")) continue;
    const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (norm.includes("..") || norm.includes(":")) continue;
    const outPath = path.join(destDir, ...norm.split("/"));
    mk(path.dirname(outPath));
    const compressed = buf.slice(dataStart, dataEnd);
    let raw;
    if (method === 0) raw = compressed;
    else if (method === 8) raw = zlib.inflateRawSync(compressed);
    else throw new Error("unsupported zip method " + method);
    fs.writeFileSync(outPath, raw);
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosStamp(d) {
  const dt = d instanceof Date ? d : new Date();
  const year = Math.max(1980, dt.getFullYear());
  return {
    time: (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate(),
  };
}
/* 最小 zip 打包器（deflateRaw 优先，压不动就 store）：只打我们自己挑好的文件，
   不引第三方依赖。UTF-8 名字置 flag 0x0800（中文 <AppName> 也能被解压工具认。） */
function zipBuffer(entries) {
  const now = dosStamp(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const ent of entries) {
    const nameBuf = Buffer.from(String(ent.name).replace(/\\/g, "/"), "utf8");
    const raw = Buffer.isBuffer(ent.data) ? ent.data : Buffer.from(String(ent.data || ""), "utf8");
    let method = 8;
    let body = zlib.deflateRawSync(raw);
    if (body.length >= raw.length) {
      method = 0;
      body = raw;
    }
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

/* ---------------- 安装 / 更新（含同名冲突三态） ---------------- */

const installing = Object.create(null);

function sendProgress(data) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) w.webContents.send("apps:progress", data);
  } catch {}
}
/* 失败码 → 一眼看懂是哪一步炸的（认不出的码只带原文，不编造结论） */
function installFailHint(code) {
  const s = String(code || "");
  if (/^sha256_mismatch/.test(s)) return "安装包校验失败（sha256 与云端目录声明不一致）";
  if (/^HTTP\s?\d+/.test(s)) return "下载安装包失败（服务端返回 " + s.replace(/^HTTP\s?/, "") + "）";
  if (/^timeout/.test(s)) return "下载安装包超时";
  if (/^too_large/.test(s)) return "安装包超过允许体积上限";
  if (/^ECONN|^ENOTFOUND|^EAI|^EHOST/.test(s)) return "连接应用目录失败（" + s + "）";
  if (/^bad_zip_url/.test(s)) return "云端目录里该应用的下载地址不合法（只允许同源 http/https）";
  if (/^not_in_catalog/.test(s)) return "云端目录里找不到这个应用";
  if (/^need_app_update/.test(s)) return "该应用要求的 MTNode 版本高于当前版本";
  if (/^pack_missing_entry/.test(s)) return "安装包解压后缺少入口 HTML（云端包结构不对）";
  if (/zip truncated|unsupported zip method/.test(s)) return "安装包损坏或压缩方式不受支持";
  if (/^bad_id/.test(s)) return "应用 id 不合法";
  if (/^need_root/.test(s)) return "尚未指定应用安装根目录";
  if (/^EACCES|^EPERM|^ENOENT|^ENOSPC/.test(s)) return "写入应用目录失败（" + s + "）";
  return "";
}
/* 只删「上次装进去的那批载荷」：账本在就按账本删，不在也只删标准三样；
   storage/ 与 <AppName>.mtnodes 绝不碰（更新安装不该弄丢用户数据）。 */
function removePayload(dir) {
  const led = readInstalled(dir);
  const rels = [];
  if (led && Array.isArray(led.files)) {
    for (const rel of led.files) {
      const abs = resolveInside(dir, rel);
      if (abs && abs !== path.resolve(dir)) rels.push(abs);
    }
  }
  for (const rel of [SUB.manifest, SUB.index, SUB.assets]) {
    const abs = path.join(dir, rel);
    if (!rels.includes(abs)) rels.push(abs);
  }
  for (const abs of rels) {
    if (abs === path.join(dir, SUB.installed) || abs === storageFile(dir)) continue;
    try {
      fs.rmSync(abs, { recursive: true, force: true });
    } catch {}
  }
}
/**
 * 安装 / 更新一个应用。
 * arg = { id, mode }：mode 空 = 同名目录存在就回三态（渲染层弹窗）；
 *   "overwrite" | "update" = 覆盖载荷（保留 storage / 画布）；"rename" = 装成 <id>-2。
 * 返回 { ok, id, renamed, updated, name, version, dir, entry } 或
 *      { ok:false, conflict:true, choices:["overwrite","rename","cancel"], existing } 或 { ok:false, error }。
 */
async function installApp(arg) {
  const a = isObj(arg) ? arg : { id: arg };
  const id = safeAppId(a.id);
  if (!id) return bad(t("应用 id 不合法"), "bad_id");
  const { root, configured } = rootPath();
  if (!configured) return Object.assign(bad(t("尚未指定应用安装根目录"), "need_root"), { needRoot: true });
  if (installing[id]) return Object.assign(bad(t("该应用已有安装任务在跑"), "busy"), { busy: true });
  installing[id] = true;
  const mode = String(a.mode || "").trim();
  sendProgress({ id: id, phase: "start", percent: 0 });
  try {
    mk(root);
    const spec = await findSpec(id);
    if (!spec) throw new Error("not_in_catalog");
    if (!spec.compatible) throw new Error("need_app_update");
    const zipUrl = resolveZipUrl(spec.zipUrl);
    if (!zipUrl) throw new Error("bad_zip_url");
    const exists = fs.existsSync(path.join(root, id));
    let targetId = id;
    if (exists && mode === "rename") targetId = uniqueAppId(root, id);
    else if (exists && mode !== "overwrite" && mode !== "update") {
      const ex = appSummary(root, id);
      sendProgress({ id: id, phase: "conflict", percent: 0 });
      return {
        ok: false,
        conflict: true,
        code: "exists",
        reason: "exists",
        id: id,
        name: spec.name,
        existing: ex,
        incoming: { id: spec.id, name: spec.name, version: spec.version },
        choices: ["overwrite", "rename", "cancel"],
        error: t("同名应用已存在"),
      };
    }
    const targetDir = appDirOf(root, targetId);
    if (!targetDir) throw new Error("bad_id");

    sendProgress({ id: id, phase: "download", percent: 5, version: spec.version });
    const zipBuf = await fetchBuffer(zipUrl, ({ got, total }) => {
      const pct = total ? Math.min(88, 5 + Math.floor((got / total) * 83)) : 40;
      sendProgress({ id: id, phase: "download", percent: pct, got: got, total: total, version: spec.version });
    });
    if (spec.sha256) {
      const h = sha256(zipBuf);
      if (h.toLowerCase() !== spec.sha256) throw new Error("sha256_mismatch");
    }
    sendProgress({ id: id, phase: "extract", percent: 92, version: spec.version });
    const staging = path.join(root, SUB.staging, targetId + "-" + Date.now().toString(36));
    rmDirRecursive(staging);
    mk(staging);
    try {
      unzipBuffer(zipBuf, staging);
      let srcDir = staging;
      const entry = safeEntry(spec.entry) || SUB.index;
      const ents = fs.readdirSync(staging);
      if (ents.length === 1) {
        const only = path.join(staging, ents[0]);
        if (fs.statSync(only).isDirectory() && fs.existsSync(path.join(only, ...entry.split("/")))) srcDir = only;
      }
      if (!fs.existsSync(path.join(srcDir, ...entry.split("/")))) throw new Error("pack_missing_entry");
      closeAppWindow(targetId);
      mk(targetDir);
      removePayload(targetDir);
      /* 包内自带的 app.json（导出时写进去的）当上一份清单：目录条目补它缺的字段，
         目录条目没有的（自绘应用）也留得住 */
      const zipMan = readJson(path.join(srcDir, SUB.manifest), null);
      /* 账本只记**这次装进去的载荷**（解包目录里的文件 + 我们写的 app.json / 补的入口页）：
         storage/store.json 与该应用自己的画布不在其中 —— 下次覆盖 / 更新安装绝不会把它们删掉。 */
      const payload = walkFiles(srcDir, "", []);
      copyDirRecursive(srcDir, targetDir);
      const man = writeManifest(targetDir, spec, zipMan || readManifest(targetDir));
      ensureStructure(targetDir, man);
      const ledger = payload.slice();
      for (const rel of [SUB.manifest, man.entry]) if (!ledger.includes(rel)) ledger.push(rel);
      writeJson(installedPath(targetDir), {
        schema: SCHEMA,
        id: targetId,
        version: man.version,
        source: zipUrl,
        sha256: sha256(zipBuf),
        files: ledger,
        installedAt: Date.now(),
      });
      sendProgress({ id: id, phase: "done", percent: 100, version: man.version });
      return {
        ok: true,
        id: targetId,
        renamed: targetId !== id,
        from: id,
        updated: exists && targetId === id,
        name: man.name,
        version: man.version,
        entry: man.entry,
        dir: targetDir,
        bytes: zipBuf.length,
        app: appSummary(root, targetId),
      };
    } finally {
      rmDirRecursive(staging);
      rmDirRecursive(path.join(root, SUB.staging));
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    sendProgress({ id: id, phase: "error", percent: 0, error: msg });
    return { ok: false, error: msg, hint: installFailHint(msg) };
  } finally {
    installing[id] = false;
  }
}

/* 卸载：只删该应用自己的子文件夹（守卫：必须严格等于 <root>/<id>；优先送系统回收站） */
async function uninstallApp(id) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const { root, configured } = rootPath();
  if (!configured) return Object.assign(bad(t("尚未指定应用安装根目录"), "need_root"), { needRoot: true });
  const dir = appDirOf(root, sid);
  if (!dir) return bad(t("非法路径"), "bad_id");
  if (!fs.existsSync(dir)) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: sid });
  closeAppWindow(sid);
  let trashed = false;
  try {
    await shell.trashItem(dir);
    trashed = true;
  } catch {}
  if (!trashed) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      return fail(err);
    }
  }
  return { ok: true, id: sid, dir: dir, trashed: trashed, root: root };
}

/* ---------------- 导出 zip（仅 app.json + index.html + assets，不含画布） ---------------- */

function exportZip(id) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const { root, configured } = rootPath();
  if (!configured) return Object.assign(bad(t("尚未指定应用安装根目录"), "need_root"), { needRoot: true });
  const dir = appDirOf(root, sid);
  if (!dir || !fs.existsSync(dir)) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: sid });
  try {
    const man = manifestOf(dir, sid);
    const entry = safeEntry(man.entry) || SUB.index;
    const entries = [];
    const manAbs = manifestPath(dir);
    if (fs.existsSync(manAbs)) entries.push({ name: SUB.manifest, data: fs.readFileSync(manAbs) });
    const entryAbs = resolveInside(dir, entry);
    if (!entryAbs || !fs.existsSync(entryAbs)) return bad(t("应用缺少入口页"), "missing_entry");
    entries.push({ name: entry, data: fs.readFileSync(entryAbs) });
    const assetsDir = path.join(dir, SUB.assets);
    if (fs.existsSync(assetsDir)) {
      for (const rel of walkFiles(assetsDir, "", [])) {
        const abs = resolveInside(assetsDir, rel);
        if (!abs || !fs.existsSync(abs)) continue;
        entries.push({ name: SUB.assets + "/" + rel, data: fs.readFileSync(abs) });
      }
    }
    const buf = zipBuffer(entries);
    const out = zipPathOf(dir, man.name);
    const tmp = out + ".tmp" + process.pid;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, out);
    return {
      ok: true,
      id: sid,
      name: man.name,
      path: out,
      file: path.basename(out),
      bytes: buf.length,
      sha256: sha256(buf),
      files: entries.length,
      version: man.version,
    };
  } catch (err) {
    return fail(err);
  }
}

/* ---------------- 变更探测（mtime 快照比对：预览刷新 + 重打包） ---------------- */

const snapshotPath = () => path.join(cacheDir(), "snapshot.json");

function snapshotOf(root) {
  const apps = Object.create(null);
  if (fs.existsSync(root)) {
    let ents = [];
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {}
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const id = safeAppId(ent.name);
      if (!id) continue;
      const s = appSummary(root, id);
      if (s) apps[id] = { files: s.files, bytes: s.bytes, mtimeMs: s.mtimeMs, version: s.version };
    }
  }
  return { at: Date.now(), root: root, apps: apps };
}
/* 与上一份快照比对：新增 / 内容变更 / 移除。首次调用（没有上一份）不算「全都变了」，
   只落一份基线并回 changed=[]。 */
function probeChanges() {
  const { root, configured } = rootPath();
  const prev = readJson(snapshotPath(), null);
  const next = snapshotOf(root);
  let changed = [];
  let added = [];
  let removed = [];
  let unchanged = 0;
  if (!prev || !isObj(prev.apps) || path.resolve(String(prev.root || "")) !== path.resolve(root)) {
    writeJson(snapshotPath(), next);
    return {
      ok: true,
      baseline: true,
      root: root,
      configured: configured,
      at: next.at,
      changed: [],
      added: Object.keys(next.apps),
      removed: [],
      unchanged: 0,
    };
  }
  for (const id of Object.keys(next.apps)) {
    const a = next.apps[id];
    const b = prev.apps[id];
    if (!b) added.push(id);
    else if (b.mtimeMs !== a.mtimeMs || b.files !== a.files || b.bytes !== a.bytes || b.version !== a.version)
      changed.push({ id: id, from: b, to: a });
    else unchanged++;
  }
  for (const id of Object.keys(prev.apps)) if (!next.apps[id]) removed.push(id);
  writeJson(snapshotPath(), next);
  return {
    ok: true,
    baseline: false,
    root: root,
    configured: configured,
    at: next.at,
    previousAt: Number(prev.at) || 0,
    changed: changed,
    added: added,
    removed: removed,
    unchanged: unchanged,
    any: !!(changed.length || added.length || removed.length),
  };
}

/* ---------------- 开发页预览：目录定位 + 预览 info（url / 内容快照） ---------------- */

/* 预览协议路由用：按 app id 找应用目录。大小写不敏感 —— URL 的 host 会被规范成小写，
   而 Windows 之外的盘上目录名可能带大写。 */
function previewDirOf(id) {
  const sid = safeAppId(id);
  if (!sid) return "";
  const { root } = rootPath();
  const direct = appDirOf(root, sid);
  if (direct && fs.existsSync(direct)) return direct;
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  const hit = ents.find(
    (e) => e.isDirectory() && e.name.toLowerCase() === sid.toLowerCase(),
  );
  const dir = hit ? path.join(root, hit.name) : "";
  return dir && fs.existsSync(dir) ? dir : "";
}
/* 开发页一次拿齐：iframe 预览 url + 内容快照（文件数 / 字节 / 最新 mtime，口径同 appSummary）。
   开发页每轮开发结束后调它，快照没变就不重载预览。 */
function devPreview(id) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const { root, configured } = rootPath();
  if (!configured)
    return Object.assign(bad(t("尚未指定应用安装根目录"), "need_root"), {
      needRoot: true,
    });
  const dir = previewDirOf(sid);
  if (!dir)
    return Object.assign(bad(t("该应用不在本机"), "missing"), {
      missing: true,
      id: sid,
    });
  const man = manifestOf(dir, sid);
  /* 入口页：先认 app.json 里声明的，缺 entry 就用默认 index.html；
     声明的入口页在磁盘上不存在也回落到默认 index.html —— 协议层（previewFileResponse）
     同样按这条链兜底，两边一起保证预览始终显示应用的默认界面 */
  const declared = safeEntry(man.entry) || SUB.index;
  const declaredAbs = resolveInside(dir, declared);
  const entry =
    declaredAbs && fs.existsSync(declaredAbs) && fs.statSync(declaredAbs).isFile()
      ? declared
      : SUB.index;
  const stat = dirStatOf(dir);
  const rel = entry.split("/").map(encodeURIComponent).join("/");
  return {
    ok: true,
    id: sid,
    name: man.name,
    version: man.version,
    dir: dir,
    entry: entry,
    url: PREVIEW_SCHEME + "://" + sid + "/" + rel,
    files: stat.files,
    bytes: stat.bytes,
    mtimeMs: stat.mtimeMs,
  };
}

/* ---------------- 独立窗口（应用宿主） ---------------- */

const appWins = new Map();
const wcToAppId = new WeakMap();
/* 关窗收尾（r1 共识）：每个应用窗口一份「等应用回包」的现场 */
const appCloseWait = new Map();

/* 关窗 = 「先请应用收尾、再关」（window.__appHost_ackClose() 回包 / 上限 WILL_CLOSE_MS）。
 * 忘了回包（老脚手架 / 页面卡住）绝不把窗口钉死：到点照样关。
 * 一个窗口只允许一条关闭链路在跑；重复调用直接忽略，不再重置计时器。 */
function closeAppWindow(id) {
  const sid = String(id || "");
  const w = appWins.get(sid);
  if (!w || w.isDestroyed()) {
    appWins.delete(sid);
    return false;
  }
  if (appCloseWait.has(sid)) return true;
  const wc = w.webContents;
  const fin = (why) => {
    appCloseWait.delete(sid);
    if (w.isDestroyed()) return;
    try {
      w.close();
    } catch {}
    /* 窗口自己的 closed 回调负责从 appWins 摘人；兜底再摘一次（close() 被吞掉也不留幽灵条目） */
    if (appWins.get(sid) === w) appWins.delete(sid);
  };
  try {
    if (wc && !wc.isDestroyed()) wc.send("apps:willClose", { id: sid, ms: WILL_CLOSE_MS });
  } catch {}
  const timer = setTimeout(() => fin("timeout"), WILL_CLOSE_MS);
  appCloseWait.set(sid, {
    ack: () => {
      clearTimeout(timer);
      fin("ack");
    },
    timer: timer,
  });
  return true;
}
/* 应用窗口侧的回包（preload-app.js 收到 apps:willClose → 跑完收尾 → invoke 这个通道） */
function ackAppClose(e) {
  const id = wcToAppId.get(e.sender) || "";
  const st = id ? appCloseWait.get(id) : null;
  if (st) st.ack();
  return { ok: true, id: id || "" };
}
function isAppWindowOpen(id) {
  const w = appWins.get(String(id || ""));
  return !!(w && !w.isDestroyed());
}
function notifyWindowChanged(id, open) {
  try {
    const mw = getMainWin && getMainWin();
    if (mw && !mw.isDestroyed()) mw.webContents.send("apps:windowChanged", { id: String(id || ""), open: !!open });
  } catch {}
}
function winBounds(spec) {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  const width = Math.min(Math.max(Number(spec.width) || DEFAULT_WINDOW.width, 360), wa.width);
  const height = Math.min(Math.max(Number(spec.height) || DEFAULT_WINDOW.height, 320), wa.height);
  return {
    width: width,
    height: height,
    x: Math.max(wa.x, wa.x + Math.round((wa.width - width) / 2)),
    y: Math.max(wa.y, wa.y + Math.round((wa.height - height) / 2)),
  };
}
/* 应用窗口：preload-app.js（window.appHost）· loadFile 应用 index.html ·
   will-navigate 一律 preventDefault（外链交 shell.openExternal）· 新窗口一律 deny。 */
function openAppWindow(id) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const existing = appWins.get(sid);
  if (existing && !existing.isDestroyed()) {
    try {
      existing.show();
      existing.focus();
    } catch {}
    notifyWindowChanged(sid, true);
    return { ok: true, id: sid, open: true, reused: true };
  }
  const { root, configured } = rootPath();
  if (!configured) return Object.assign(bad(t("尚未指定应用安装根目录"), "need_root"), { needRoot: true });
  const dir = appDirOf(root, sid);
  if (!dir || !fs.existsSync(dir)) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: sid });
  const man = manifestOf(dir, sid);
  const entry = safeEntry(man.entry) || SUB.index;
  const html = resolveInside(dir, entry);
  if (!html || !fs.existsSync(html)) return bad(t("应用入口页不存在"), "missing_entry");
  const spec = readJson(catalogCachePath(), null);
  let winSpec = DEFAULT_WINDOW;
  try {
    const cat = spec && spec.doc ? parseCatalogDoc(spec.doc) : null;
    const hit = cat ? cat.apps.find((a) => a.id === sid) : null;
    if (hit && isObj(hit.window)) winSpec = Object.assign({}, DEFAULT_WINDOW, hit.window);
  } catch {}
  const pos = winBounds(winSpec);
  /* 窗口标题取 app.json 的 title（缺了退回 name）；图标一律用内置默认图标 ——
     应用不能自带图标文件指定给窗口（icon 字段只进卡片封面，不喂 BrowserWindow）。 */
  const winTitle = String(man.title || man.name || sid);
  const defaultIcon = path.join(__dirname, "build", "icon.png");
  /* 窗口外观认目录条目 window 里的 frame / transparent / alwaysOnTop / skipTaskbar（与插件目录词条
     同口径）；没写就是普通可缩放窗口。位置固定在主显示器工作区居中，应用不能指定坐标。 */
  const frame = winSpec.frame === true;
  const transparent = winSpec.transparent === true;
  const w = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    minWidth: Math.max(360, Number(winSpec.minWidth) || DEFAULT_WINDOW.minWidth),
    minHeight: Math.max(240, Number(winSpec.minHeight) || DEFAULT_WINDOW.minHeight),
    resizable: true,
    frame: frame,
    transparent: transparent,
    alwaysOnTop: winSpec.alwaysOnTop === true,
    skipTaskbar: winSpec.skipTaskbar === true,
    show: false,
    title: winTitle,
    icon: fs.existsSync(defaultIcon) ? defaultIcon : undefined,
    backgroundColor: transparent ? "#00000000" : "#0d1016",
    webPreferences: {
      preload: path.join(__dirname, "preload-app.js"),
      additionalArguments: ["--mtnode-app-id=" + sid],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  w.setMenu(null);
  if (winSpec.alwaysOnTop === true) {
    try {
      w.setAlwaysOnTop(true, "screen-saver");
    } catch {}
  }
  w.webContents.on("will-navigate", (ev, url) => {
    if (url && url !== w.getURL()) {
      ev.preventDefault();
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
        try {
          shell.openExternal(url);
        } catch {}
      }
    }
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || "");
    if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) {
      try {
        shell.openExternal(u);
      } catch {}
    }
    return { action: "deny" };
  });
  wcToAppId.set(w.webContents, sid);
  appWins.set(sid, w);
  w.loadFile(html);
  w.once("ready-to-show", () => {
    if (!w.isDestroyed()) {
      try {
        w.show();
        w.focus();
      } catch {}
    }
  });
  w.on("closed", () => {
    appWins.delete(sid);
    const st = appCloseWait.get(sid);
    if (st) {
      clearTimeout(st.timer);
      appCloseWait.delete(sid);
    }
    notifyWindowChanged(sid, false);
  });
  notifyWindowChanged(sid, true);
  return { ok: true, id: sid, open: true, reused: false, title: winTitle, version: man.version };
}
function closeSenderAppWindow(e) {
  const id = wcToAppId.get(e.sender) || "";
  if (id) closeAppWindow(id);
  else {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) {
      try {
        w.close();
      } catch {}
    }
  }
  return { ok: true };
}
function shutdownApps() {
  /* 逐个走 closeAppWindow（= 先请应用收尾、再关）；每个窗口最多等 WILL_CLOSE_MS，
     到点自己会关，所以这里不需要等 —— before-quit 也没法等 Promise。 */
  for (const id of [...appWins.keys()]) closeAppWindow(id);
}
/* 「关掉 MTNode 本身」的那条路（应用窗口里的 appHost.quit）：
 * 先让每个应用窗口走一遍收尾，再请主进程退出；收尾与退出都不由应用侧插手。 */
let requestQuit = null;
function setQuitHandler(fn) {
  requestQuit = typeof fn === "function" ? fn : null;
}
function quitFromAppWindow(e) {
  const id = wcToAppId.get(e.sender) || "";
  if (id) closeAppWindow(id);
  /* 交给主进程走正常的退出流程（before-quit → shutdownApps 再收一遍，幂等） */
  try {
    if (requestQuit) requestQuit();
    else app.quit();
  } catch {
    try {
      app.quit();
    } catch {}
  }
  return { ok: true, id: id || "" };
}

function appIdOfSender(e) {
  return wcToAppId.get(e.sender) || "";
}
/* 发送方窗口所属应用的目录。**认 id 不认目录**：数据落盘与关窗收尾都不依赖
 * 「应用安装根目录已设置 / 应用还在本机」——那两样只影响装载与静态文件（见 openAppWindow）。
 * dir 取得到时顺手回一份（老调用方 hostSpec 等不用改）。 */
function senderAppDir(e) {
  const id = appIdOfSender(e);
  if (!id) return null;
  const { root, configured } = rootPath();
  const dir = configured ? appDirOf(root, id) : "";
  return { id: id, dir: dir && fs.existsSync(dir) ? dir : "" };
}

/* ---------------- appHost：模型调用（服务商与 Key 只在本进程解析） ---------------- */

function providersFromConfig() {
  const cfg = readJson(configPath(), {}) || {};
  return Array.isArray(cfg.providers) ? cfg.providers.filter((p) => isObj(p)) : [];
}
function modelIdsOf(p) {
  return (Array.isArray(p && p.models) ? p.models : [])
    .map((m) => (typeof m === "string" ? m : m && m.id))
    .filter(Boolean)
    .map(String);
}
/* 默认服务商：文本优先 DeepSeek 官方（本机配置里 host 含 deepseek 的那条），否则第一条可用文本；
   图像优先第一条 image_* 服务商。应用窗口**不能**指定服务商 / Key / 模型 id —— 只能给提示词。 */
function providerFor(kind) {
  const list = providersFromConfig();
  const usable = (p) => !!String(p.apiKey || "").trim() && !!String(p.baseUrl || "").trim();
  if (kind === "image") return list.filter((p) => /^image_/.test(String(p.type || "")) && usable(p))[0] || null;
  const texts = list.filter((p) => String(p.type || "") === "text_openai" && usable(p));
  return texts.find((p) => isDeepseekHost(p.baseUrl)) || texts[0] || null;
}
function normRole(v) {
  const r = String(v || "").trim().toLowerCase();
  return r === "system" || r === "assistant" || r === "user" ? r : "";
}
/* 应用侧消息白名单：role 只认 system/user/assistant，content 只认字符串且有上限 */
function normMessages(opts) {
  const out = [];
  const src = Array.isArray(opts.messages) ? opts.messages.slice(0, MAX_MESSAGES) : [];
  for (const m of src) {
    if (!isObj(m)) continue;
    const role = normRole(m.role);
    const content = typeof m.content === "string" ? m.content : "";
    if (!role || !content.trim()) continue;
    out.push({ role: role, content: content.slice(0, MAX_PROMPT) });
  }
  if (out.length) return out;
  const system = typeof opts.system === "string" ? opts.system.trim() : "";
  const prompt = typeof opts.prompt === "string" ? opts.prompt : "";
  if (system) out.push({ role: "system", content: system.slice(0, MAX_PROMPT) });
  out.push({ role: "user", content: prompt.slice(0, MAX_PROMPT) });
  return out;
}
function hostSpec(id, kind, opts) {
  const provider = providerFor(kind);
  if (!provider) {
    return {
      error:
        kind === "image"
          ? t("未配置可用的图像服务商（请在「设置 · API/配置」中填写）")
          : t("未配置可用的文本服务商（请在「设置 · API/配置」中填写）"),
    };
  }
  const model = modelIdsOf(provider)[0] || "";
  const o = isObj(opts) ? opts : {};
  if (kind === "image") {
    return {
      spec: {
        provider: provider,
        kind: "image",
        model: model,
        prompt: String(o.prompt || "").slice(0, MAX_PROMPT),
        size: String(o.size || ""),
        quality: String(o.quality || ""),
        background: String(o.background || ""),
      },
    };
  }
  const messages = normMessages(o);
  const temp = Number(o.temperature);
  return {
    spec: {
      provider: provider,
      kind: "text",
      model: model,
      prompt: messages.length ? messages[messages.length - 1].content : "",
      chatMessages: messages,
      temperature: Number.isFinite(temp) ? Math.max(0, Math.min(2, temp)) : 0.7,
      maxTokens: Number(o.maxTokens) > 0 ? Math.round(Number(o.maxTokens)) : 0,
    },
  };
}
async function hostText(e, opts) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const built = hostSpec(own.id, "text", opts);
  if (built.error) return bad(built.error, "no_provider");
  if (typeof aiCall !== "function") return bad(t("模型调用内核不可用"), "no_kernel");
  try {
    const r = await aiCall(built.spec);
    return { ok: true, text: String((r && r.text) || "") };
  } catch (err) {
    return fail(err);
  }
}
async function hostTextStream(e, opts) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const built = hostSpec(own.id, "text", opts);
  if (built.error) return bad(built.error, "no_provider");
  const wc = e.sender;
  const reqId = String((isObj(opts) && opts.reqId) || "");
  const emit = (type, data) => {
    try {
      if (!wc.isDestroyed()) wc.send("apps:hostStream", Object.assign({ reqId: reqId, type: type }, data || {}));
    } catch {}
  };
  if (typeof aiCallStream !== "function") {
    const r = await hostText(e, opts);
    emit(r.ok ? "done" : "error", r.ok ? { text: r.text } : { error: r.error });
    return r;
  }
  try {
    const r = await aiCallStream(built.spec, emit);
    return { ok: true, text: String((r && r.text) || ""), reasoning: String((r && r.reasoning) || "") };
  } catch (err) {
    const msg = String((err && err.message) || err);
    emit("error", { error: msg });
    return { ok: false, error: msg };
  }
}
async function hostImage(e, opts) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const built = hostSpec(own.id, "image", opts);
  if (built.error) return bad(built.error, "no_provider");
  if (!String(built.spec.prompt || "").trim()) return bad(t("缺少提示词"), "no_prompt");
  if (typeof aiCall !== "function") return bad(t("模型调用内核不可用"), "no_kernel");
  try {
    const r = await aiCall(built.spec);
    const b64 = String((r && r.base64) || "");
    const ext = String((r && r.ext) || "png");
    if (!b64) return bad(t("响应无图像数据"), "no_image");
    const mime = ext === "jpeg" || ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    return { ok: true, mime: mime, base64: b64, dataUrl: "data:" + mime + ";base64," + b64, bytes: Buffer.from(b64, "base64").length };
  } catch (err) {
    return fail(err);
  }
}

/* ---------------- appHost：数据落盘（默认数据根 / 可改的数据文件夹） ----------------
 *
 * 应用侧的三档落盘都在这一层，参数一律是「本应用」的东西（id 从发送方窗口认）：
 *   dataDirGet()                → 当前数据文件夹（默认数据根 or 用户选过的那个）
 *   dataDirPick()               → 弹系统目录选择框，用户亲自选完写指针（agent 不能代选）
 *   dataDirOpen()               → 在资源管理器中打开数据文件夹
 *   dataRead({ file? })         → data.json 整份对象（没有 = {}；缺了先迁老 storage/store.json）
 *   dataWrite({ data, file? })  → 整份替换写盘（原子 tmp+rename；超 2MB 拒绝）
 * 外加老通道 storageGet / Set / All / Remove：走同一个 data.json 的内部 kv，
 * 老的便签式应用照旧能用，且数据与 data.json 落在同一处。 */

function readDataFile(target) {
  const j = readJson(target.file, null);
  return isObj(j) ? j : {};
}
/* 整份替换写盘：先量体积再原子写（写坏 = 没有，绝不半截） */
function writeDataFile(target, data) {
  const body = JSON.stringify(isObj(data) ? data : {});
  if (body.length > MAX_DATA_FILE) return bad(t("应用数据超出上限（2MB）"), "storage_full");
  if (target.dir && !fs.existsSync(target.dir)) mk(target.dir);
  writeJson(target.file, isObj(data) ? data : {});
  return { ok: true, file: target.file, dir: target.dir, bytes: body.length };
}
/* 老 storage 那组用的「内部 kv」：读 → 迁老档 → 取 obj.kv；写 → 整份替回去 */
function readKvOf(id) {
  const r = readAppData(id, DATA_FILE);
  const data = isObj(r.data) ? r.data : {};
  return { data: data, kv: isObj(data.kv) ? data.kv : {}, file: r.file, migrated: !!r.migrated };
}

function hostDataDirGet(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  try {
    const dir = appDataDirOf(own.id);
    const p = readDataDirPointer(own.id);
    const root = appDataRoot(own.id);
    return {
      ok: true,
      id: own.id,
      dir: dir,
      root: root,
      def: !p,
      /* 目录还不存在时也回 ok —— 应用可以照常显示路径，落盘时宿主自己会建 */
      exists: fs.existsSync(dir),
      allow: dataAllowList(own.id),
      file: path.join(dir, DATA_FILE),
    };
  } catch (err) {
    return fail(err);
  }
}
async function hostDataDirPick(e, arg) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const r = await pickAppDataDir(own.id, isObj(arg) ? arg : {});
  if (!r || !r.ok) return r || bad(t("选择数据文件夹失败"), "pick_failed");
  return Object.assign({}, r, { exists: fs.existsSync(r.dir) });
}
async function hostDataDirOpen(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  return openAppDataDir(own.id);
}
/* 回到默认数据文件夹：只删「用户选过」的指针，原目录里的数据原样留着 */
function hostDataDirReset(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  try {
    const r = clearDataDirPointer(own.id);
    return Object.assign({}, r, { exists: fs.existsSync(r.dir) });
  } catch (err) {
    return fail(err);
  }
}
function hostDataRead(e, arg) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const name = (isObj(arg) && arg.file) || DATA_FILE;
  const r = readAppData(own.id, name);
  return { ok: true, data: r.data, file: r.file, migrated: r.migrated, dir: appDataDirOf(own.id) };
}
function hostDataWrite(e, arg) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const a = isObj(arg) ? arg : {};
  const target = resolveDataTarget(own.id, a.file);
  if (!target) return bad(t("数据文件名不合法"), "bad_file");
  return writeDataFile(target, a.data);
}

/* ---------------- appHost：老存储通道（内部 kv，走同一个 data.json） ---------------- */

function normStorageKey(key) {
  const k = String(key == null ? "" : key).trim();
  if (!k || k.length > STORAGE_KEY_MAX) return "";
  return k;
}
function hostStorageGet(e, arg) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const key = normStorageKey(isObj(arg) ? arg.key : arg);
  if (!key) return bad(t("存储键不合法"), "bad_key");
  const r = readKvOf(own.id);
  return { ok: true, key: key, value: Object.prototype.hasOwnProperty.call(r.kv, key) ? r.kv[key] : null };
}
function hostStorageSet(e, arg) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const a = isObj(arg) ? arg : {};
  const key = normStorageKey(a.key);
  if (!key) return bad(t("存储键不合法"), "bad_key");
  const target = resolveDataTarget(own.id, DATA_FILE);
  if (!target) return bad(t("数据文件名不合法"), "bad_file");
  const r = readKvOf(own.id);
  const data = r.data;
  const kv = Object.assign({}, r.kv);
  kv[key] = a.value == null ? null : a.value;
  data.kv = kv;
  const w = writeDataFile(target, data);
  if (!w.ok) return w;
  return { ok: true, bytes: w.bytes, file: w.file };
}
function hostStorageAll(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  return { ok: true, kv: readKvOf(own.id).kv };
}
function hostStorageRemove(e, arg) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const key = normStorageKey(isObj(arg) ? arg.key : arg);
  if (!key) return bad(t("存储键不合法"), "bad_key");
  const target = resolveDataTarget(own.id, DATA_FILE);
  if (!target) return bad(t("数据文件名不合法"), "bad_file");
  const r = readKvOf(own.id);
  const data = r.data;
  const kv = Object.assign({}, r.kv);
  delete kv[key];
  data.kv = kv;
  const w = writeDataFile(target, data);
  if (!w) return bad(t("写入失败"), "write_failed");
  return w;
}

/* ---------------- appHost：账号摘要 ---------------- */

/* 账号摘要：直接回 auth-store 的 state（本来就不含 token）；应用窗口只看得到「有没有登录 + 谁」 */
function hostAccount(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  try {
    const st = authState() || {};
    return {
      ok: true,
      loggedIn: !!st.loggedIn,
      user: st.user || null,
      encryption: String(st.encryption || ""),
    };
  } catch (err) {
    return fail(err);
  }
}
/* ---------------- IPC 注册 ---------------- */

function registerAppsIpc(opts) {
  opts = opts || {};
  if (typeof opts.getDataDir === "function") getDataDir = opts.getDataDir;
  if (typeof opts.getMainWin === "function") getMainWin = opts.getMainWin;
  if (typeof opts.getAppVersion === "function") getAppVersion = opts.getAppVersion;
  if (typeof opts.t === "function") t = opts.t;
  if (typeof opts.authState === "function") authState = opts.authState;
  if (typeof opts.aiCall === "function") aiCall = opts.aiCall;
  if (typeof opts.aiCallStream === "function") aiCallStream = opts.aiCallStream;

  const guard = (fn) => (e, arg) => {
    try {
      return fn(e, arg);
    } catch (err) {
      return fail(err);
    }
  };

  /* 根目录：get / set / pick（set 与 pick 都是主进程写 config.json，渲染层不管路径） */
  ipcMain.handle("apps:rootGet", guard(() => {
    const { root, configured } = rootPath();
    return {
      ok: true,
      path: root,
      configured: configured,
      exists: fs.existsSync(root),
      defaultPath: (() => {
        try {
          return defaultRoot();
        } catch {
          return "";
        }
      })(),
    };
  }));
  ipcMain.handle("apps:rootSet", guard((e, arg) => setRoot(typeof arg === "string" ? arg : isObj(arg) ? arg.path : "")));
  ipcMain.handle("apps:rootPick", async (e, arg) => {
    try {
      const r = await pickRoot();
      if (!r.ok) return r;
      return Object.assign({}, r, { list: listApps() });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("apps:list", guard(() => listApps()));
  /* 新建应用：{ name 标题, id 文件夹名 } → 建 <root>/<id>/ + app.json（画布由渲染层
     紧接着走既有 workflow:save 建，见 createApp 头部注释）。 */
  ipcMain.handle("apps:create", guard((e, arg) => createApp(arg)));
  ipcMain.handle("apps:catalog", async (e, arg) => {
    try {
      return await loadCatalog(arg || {});
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:install", async (e, arg) => {
    try {
      return await installApp(arg);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:uninstall", async (e, arg) => {
    try {
      return await uninstallApp(isObj(arg) ? arg.id : arg);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:exportZip", guard((e, arg) => exportZip(isObj(arg) ? arg.id : arg)));
  ipcMain.handle("apps:probeChanges", guard(() => probeChanges()));
  /* 开发页预览：url（mtnode-preview://）+ 内容快照；协议本身在这里注册（此时已 ready） */
  try {
    registerPreviewProtocol();
  } catch (err) {
    console.warn("[apps-preview] 预览协议注册失败：" + ((err && err.message) || err));
  }
  ipcMain.handle("apps:devPreview", guard((e, arg) => devPreview(isObj(arg) ? arg.id : arg)));

  ipcMain.handle("apps:openWindow", guard((e, arg) => openAppWindow(isObj(arg) ? arg.id : arg)));
  ipcMain.handle("apps:closeWindow", guard((e) => closeSenderAppWindow(e)));
  ipcMain.handle("apps:isOpen", guard((e, arg) => {
    const id = safeAppId(isObj(arg) ? arg.id : arg);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    return { ok: true, id: id, open: isAppWindowOpen(id) };
  }));

  /* ── appHost（应用窗口侧；只注册白名单那四项 + 关自己的窗口；全部按发送方窗口认应用，
        认不出就拒绝）。hostText 不单独开通道：它只作为流式失败时的内核回退。 ── */
  ipcMain.handle("apps:hostTextStream", async (e, arg) => {
    try {
      return await hostTextStream(e, arg);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:hostImage", async (e, arg) => {
    try {
      return await hostImage(e, arg);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:hostStorageGet", guard((e, arg) => hostStorageGet(e, arg)));
  ipcMain.handle("apps:hostStorageSet", guard((e, arg) => hostStorageSet(e, arg)));
  ipcMain.handle("apps:hostStorageAll", guard((e) => hostStorageAll(e)));
  ipcMain.handle("apps:hostStorageRemove", guard((e, arg) => hostStorageRemove(e, arg)));
  ipcMain.handle("apps:hostAccount", guard((e) => hostAccount(e)));
  /* 数据落盘（默认数据根 / 可改的数据文件夹）+ 关窗收尾回包 */
  ipcMain.handle("apps:hostDataDirGet", guard((e) => hostDataDirGet(e)));
  ipcMain.handle("apps:hostDataDirPick", async (e, arg) => {
    try {
      return await hostDataDirPick(e, arg);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:hostDataDirOpen", async (e) => {
    try {
      return await hostDataDirOpen(e);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:hostDataRead", guard((e, arg) => hostDataRead(e, arg)));
  ipcMain.handle("apps:hostDataWrite", guard((e, arg) => hostDataWrite(e, arg)));
  ipcMain.handle("apps:hostDataDirReset", guard((e) => hostDataDirReset(e)));
  ipcMain.handle("apps:ackClose", guard((e) => ackAppClose(e)));
  ipcMain.handle("apps:quit", guard((e) => quitFromAppWindow(e)));

  /* ── 应用数据（主窗口 / 应用中心侧）：库页 / 开发页那一行的数据文件夹 ──
     dataDir 只读写，选目录走 apps:dataDirPick（一定要用户亲自选），不开放任意写通道。 */
  ipcMain.handle("apps:dataInfo", guard((e, arg) => {
    const id = safeAppId(isObj(arg) ? arg.id : arg);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    try {
      const dir = appDataDirOf(id);
      const p = readDataDirPointer(id);
      const root = appDataRoot(id);
      return {
        ok: true,
        id: id,
        dir: dir,
        root: root,
        def: !p,
        exists: fs.existsSync(dir),
        files: fs.existsSync(dir) ? walkFiles(dir, "", []).length : 0,
      };
    } catch (err) {
      return fail(err);
    }
  }));
  ipcMain.handle("apps:dataDirPick", async (e, arg) => {
    try {
      const id = safeAppId(isObj(arg) ? arg.id : arg);
      if (!id) return bad(t("应用 id 不合法"), "bad_id");
      return await pickAppDataDir(id, (isObj(arg) && arg) || {});
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:dataDirReset", guard((e, arg) => {
    const id = safeAppId(isObj(arg) ? arg.id : arg);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    try {
      const r = clearDataDirPointer(id);
      return Object.assign({}, r, { exists: fs.existsSync(r.dir) });
    } catch (err) {
      return fail(err);
    }
  }));
}

module.exports = {
  registerAppsIpc,
  shutdownApps,
  setQuitHandler,
  rootPath,
  setRoot,
  listApps,
  createApp,
  mirrorAppCanvas,
  loadCatalog,
  installApp,
  uninstallApp,
  exportZip,
  probeChanges,
  devPreview,
  registerPreviewProtocol,
  openAppWindow,
  closeAppWindow,
  ackAppClose,
  isAppWindowOpen,
  isInsideAppDir,
  safeAppId,
  appDirOf,
  canvasPathOf,
  zipPathOf,
  /* 应用数据（默认数据根 + 每应用可改的数据文件夹）：
     smoke 直接真跑这几个纯函数，不用起 Electron 窗口 */
  appDataRoot,
  appDataDirOf,
  dataDirPointerFile,
  readDataDirPointer,
  writeDataDirPointer,
  clearDataDirPointer,
  dataAllowList,
  normDataFileName,
  resolveDataTarget,
  readAppData,
  migrateLegacyStorage,
  openAppDataDir,
  pickAppDataDir,
  /* 纯函数段：zip 打包 / 解包与相对路径解析（冒烟测试直接真跑，不用起 Electron 窗口） */
  zipBuffer,
  unzipBuffer,
  resolveInside,
};
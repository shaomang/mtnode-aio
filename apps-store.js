"use strict";

/* ── 应用宿主（用户自建应用）· 主进程侧 ─────────────────────────────────────
 *
 * 「应用」= 用户 / 云端目录分发的本机小应用：一个文件夹一份，里面自带 index.html + assets，
 * 由 MTNode 开独立窗口（preload-app.js，桥 = window.appHost）跑起来；它自己的画布存成同目录的
 * <AppName>.mtnodes，整份应用可导出成 <AppName>.zip（**不含画布**）迁移 / 上架。
 *
 * 根目录（所有应用都装在它的下一层）：
 *   <root>/<id>/                     id = 文件夹名（app id 合法化见 safeAppId）
 *     app.json                       应用清单（可迁移：id / name / version / entry / description / icon
 *                                    + 本机状态：author 作者 / dev 开发中 / forkOf 二次开发来源）
 *     index.html                     入口页（zip 里带；缺失时补一份最小脚手架）
 *     assets/**                      应用自带资产（导出 zip 只带它 + app.json + index.html）
 *     storage/store.json             **该应用自己的本机存储**（appHost.storageGet / storageSet）
 *     <AppName>.mtnodes              该应用的画布（保存画布时写入；导出 zip 与更新安装都不碰它）
 *     <AppName>.zip                  导出的应用包（appHost 目录 = 用户搬家 / 上架用）
 *     installed.json                 本机安装账本（本次装进去的文件清单 / 来源 / sha256 / 来源作者，**不导出**）
 *   <root>/                          .staging/ 为解包中转目录，装完即清
 *
 * 根目录设置（沿用 installDir 口径的键名，**写在本机 config.json，不写应用目录**）：
 *   <数据目录>/config.json → { "apps": { "installDir": "<绝对路径>" } }
 *   兼容读 appInstallDir / appsInstallDir / appsRoot（老写法 / 手改过的配置）；
 *   用户没指定时默认 <数据目录>/apps（默认落在 %APPDATA%，绝不落应用目录）。
 *   路径守卫（与 main.js isInsideAppDir 同口径）：解析结果等于或位于 app.getAppPath() /
 *   exe 同目录之下一律拒绝 —— 那里升级 / 卸载会带走或覆盖用户的应用。
 *
 * 云端目录与缓存（**双源**，见 docs/apps-market.md §三 / §6）：
 *   MTNODE_APPS_URL（默认 http://mt-agent.com/mtnode/apps）+ /catalog.json   ← 首选（静态目录）
 *   MTNODE_STORE_URL（默认 https://www.mt-agent.com/mtnode/store-api）+ /api/apps/catalog ← 兜底（接口目录）
 *   → { version, updatedAt, apps: [{ id, title, version, latestVersion, entry, zipUrl, sha256, icon,
 *       owner, ownerId, forkOf, window, versions: [{ version, parentVersion, zipUrl, sha256, bytes,
 *       uploader, createdAt, note }], … }] }
 *   读目录顺序：静态 → 接口 → 本机缓存（<数据目录>/apps-cache/catalog.json）→ 空列表；
 *   响应带 source（remote / api / cache / empty）与 sourceBase，每条条目带 sourceBase + urls。
 *   **静态目录为空按「不可用」处理**（不是「云端没有应用」）—— 静态文件被部署链刷空是发生过的事故。
 *   下载地址与图标按来源解析（zipUrlsOf）：静态 = FEED + <id>.zip / <id>/<版本>.zip / icons/<id>.<ext>；
 *   接口 = <store>/api/apps/<id>/file?[version=]<版本>&format=raw 与 /api/apps/<id>/icon。
 *   多版本口径见 docs/apps-market.md §七：versions[] 缺省时按「就这一版」合成一项（老目录也能读）。
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
 *   apps:setMeta（本机状态字段 dev / author / forkOf 的唯一写入口，渲染层不碰文件系统）
 *   apps:exportZip · apps:probeChanges · apps:openWindow / closeWindow / isOpen
 *   apps:shotWindow · apps:readZipBase64（上架窗用：拍应用自己的窗口 + 现打包读回 base64，
 *   契约见 docs/apps-market.md §七；渲染层不碰文件系统与网络）
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
const { app, BrowserWindow, ipcMain, dialog, shell, screen, protocol, session } = require("electron");
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
/* 云端接口目录（与 main.js 的 MTNODE_STORE_URL 同值同义）：
   静态目录是客户端首选入口，但它是一份**服务端落盘的文件** —— 一旦部署链把它刷空、
   或包/图标没同步，整个应用库就等于断线（「应用库未连入云端」）。
   所以静态目录为空 / 拉不到时回退到这个接口（同源、同一份 appCatalogEntry 字段口径）。 */
const STORE_BASE = (
  process.env.MTNODE_STORE_URL || "https://www.mt-agent.com/mtnode/store-api"
).replace(/\/+$/, "");
/* 目录条目的「来源基址」：静态目录 = FEED，接口目录 = STORE_BASE。
   下载地址与图标都相对它解析（静态 <id>.zip / icons/<id>.<ext>；接口 /api/apps/<id>/file?format=raw、/api/apps/<id>/icon）。 */
const SOURCE_BASE = Symbol.for("mtnode.apps.sourceBase");
/* 目录来源标记：渲染层用它区分「云端静态目录 / 云端接口 / 本机缓存」 */
const SOURCE_KIND = Symbol.for("mtnode.apps.sourceKind");
const MAX_CATALOG = 512 * 1024;
const MAX_ZIP = 200 * 1024 * 1024;
const MAX_STORAGE = 2 * 1024 * 1024;
const STORAGE_KEY_MAX = 200;
const MAX_PROMPT = 100 * 1024;
const MAX_MESSAGES = 60;
/* appHost 多模态（文本 + 图像）上限：单条消息最多 8 张图、单次请求图像原始字节合计 10MB。
   超限一律回结构化错误码（too_many_images / too_large），不静默丢图。 */
const MAX_MSG_IMAGES = 8;
const MAX_MSG_IMAGE_BYTES = 10 * 1024 * 1024;
const MODEL_AUTO = "auto";
const IMG_EXT_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
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

/* ---------------- 应用设计风格（新建时选 / 开发页换） ----------------
 *
 * 一套风格 = 一份「语义变量赋值 + 少量质感覆盖」，落在 templates/app-default/styles/<id>.css；
 * 结构与排版在 templates/app-default/base.css；页面 DOM 与正文在 index.html（与风格无关）。
 * 这里做三件事：
 *   ① APP_STYLES 是**风格清单的唯一真源**（渲染层用 apps:styles 取它，不再各写一份）；
 *   ② 注入入口页时把 base.css + styles/<id>.css 内联进模板的 <style>（写完仍是单文件）；
 *   ③ 选中的风格写进 app.json 的 style 字段；没有该字段（老应用 / 云端包）一律按默认风格看待。
 * 契约与新增风格的步骤见 templates/app-default/STYLES.md。 */
const APP_STYLE_FALLBACK = "minimal";
const APP_STYLES = [
  {
    id: "minimal",
    zh: "极简",
    en: "Minimal",
    why: "工程笔记本：深墨底、一根竖线，材料只有线、留白与一个紫点",
    swatch: ["#0a0c12", "#1d2230", "#c792ea"],
  },
  {
    id: "tech",
    zh: "科技",
    en: "Tech",
    why: "石墨底 + 冷青强调 + 等宽标记，编号做成刻度盘",
    swatch: ["#070b12", "#16232e", "#5ad9e0"],
  },
  {
    id: "warm",
    zh: "暖读",
    en: "Warm",
    why: "纸白底、暖棕墨、大字号衬线，读五分钟也不累",
    swatch: ["#faf7f1", "#e2dacb", "#2f6b4a"],
  },
  {
    id: "editorial",
    zh: "编辑",
    en: "Editorial",
    why: "杂志内页：超大衬线标题、首字下沉、细横线分栏",
    swatch: ["#ffffff", "#12100e", "#b32c1f"],
  },
  {
    id: "terminal",
    zh: "终端",
    en: "Terminal",
    why: "磷光绿单色屏：等宽字、扫描线、提示符光标",
    swatch: ["#05100a", "#1d4530", "#4fe08a"],
  },
  {
    id: "glass",
    zh: "玻璃拟态",
    en: "Glass",
    why: "夜空光斑 + 磨砂面板 + 大圆角，正文坐在有边的玻璃里",
    swatch: ["#0a0a12", "#5a78ff", "#a9a0ff"],
  },
  {
    id: "retro",
    zh: "复古印刷",
    en: "Retro print",
    why: "棉纸底、粗线条、网点编号，一处红色错版",
    swatch: ["#f7f4ec", "#1a1713", "#c0322b"],
  },
  {
    /* 「自定义」不是一套预设风格，而是**一条询问入口**：选中它不写死外观，而是让开发会话
       先问用户「你要什么风格」——用户描述了自己的品味，或让 AI 按应用用途提几套方案，
       再按答案把这个应用的入口页做出来（详见 renderer/app-app-flow.js 的自定义那一段）。
       所以它没有 styles/<id>.css、也没有 previews/<id>.png：卡片用占位视觉，
       入口页生成时落 minimal 那套（页面绝不花），真正的长相由开发会话按答案改写。 */
    id: "custom",
    zh: "自定义",
    en: "Custom",
    why: "先问你要什么风格：你提要求，或让 AI 按应用用途先提几套方案",
    swatch: ["#0a0c12", "#5b6cff", "#c792ea"],
    custom: true,
  },
];
const APP_STYLE_IDS = APP_STYLES.map((s) => s.id);
/* 7 套预设风格（可注入的模板）：custom 不在其中 —— 它没有模板文件，入口页落默认那套 */
const APP_PRESET_STYLE_IDS = APP_STYLES.filter((s) => s.custom !== true).map((s) => s.id);
const APP_CUSTOM_STYLE = "custom";
const APP_DEFAULT_STYLE = APP_STYLE_FALLBACK;
/* 风格 id 合法化：认不出一律回落默认（老 app.json / 云端包 / 手改坏了一样能打开） */
function normAppStyle(v) {
  const id = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return APP_PRESET_STYLE_IDS.indexOf(id) >= 0 ? id : APP_DEFAULT_STYLE;
}
/* 写盘 / 回显口径：**多留一个 custom** —— app.json 要记住「用户选的是自定义」，
   否则开发页与「换风格…」会把它当成极简，问风格的这一轮就再也回不来了。
   认不出的值仍旧回落默认（与 normAppStyle 同一口径）。 */
function normStoredAppStyle(v) {
  const id = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  if (id === APP_CUSTOM_STYLE) return APP_CUSTOM_STYLE;
  return normAppStyle(id);
}
/* 这套风格是不是「自定义」（要先去问用户风格要求的那一套） */
function appStyleIsCustom(style) {
  return String(style == null ? "" : style)
    .trim()
    .toLowerCase() === APP_CUSTOM_STYLE;
}
function appStyleIds() {
  return APP_STYLE_IDS.slice();
}
/* 可注入模板的预设风格 id（生成入口页 / 预览图只看这一份） */
function appPresetStyleIds() {
  return APP_PRESET_STYLE_IDS.slice();
}

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
/* 上架截图当图标上传时的体积上限（与服务端 icons 口径 MAX_PREVIEW = 500KB 对齐） */
const ICON_SHOT_MAX_BYTES = 500 * 1024;
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
/* 图像缩放内核：registerAppsIpc 注入（main.js 的 shrinkImageBuffer），默认原样返回 */
let shrinkImage = (buf, ext) => ({ buf: buf, ext: ext });
/* 模型目录（main.js 注入 dsh().providerCatalog）：用来判某个模型是否「支持识图」 */
let providerCatalog = null;

/* ---------------- 通用小工具 ---------------- */

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
/* 失败回执统一带 reason（给代码看）与 error（给人看）；reason 顺带暴露成 code，
   应用侧只判 code 即可分支（桥的错误码就是契约，见 preload-app.js 头部）。 */
function bad(msg, reason) {
  const r = String(reason || "");
  return { ok: false, reason: r, code: r, error: String(msg || "") };
}
/* 模型调用异常 → 结构化错误码：断网 / 超时 / HTTP 状态各归一档，应用据此给可操作提示 */
function callErrCode(err) {
  const st = Number(err && err.httpStatus);
  if (Number.isFinite(st) && st >= 400) return "http_" + Math.round(st);
  const code = String((err && err.code) || "");
  const msg = String((err && err.message) || "");
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed/i.test(code + " " + msg))
    return "offline";
  return "";
}
function fail(err) {
  return Object.assign({ ok: false, error: String((err && err.message) || err) }, { code: callErrCode(err) });
}

/* 应用侧「选图」：系统对话框（只有用户亲自选的那一次生效），回 { ok, path }；取消回 cancelled。
   只把**路径**给应用，读盘 / 解码 / 缩放一律留在主进程（见 imagePartUrl）。 */
async function pickImageForApp(parent) {
  const r = await dialog.showOpenDialog(parent || undefined, {
    title: t("选择图像"),
    properties: ["openFile"],
    filters: [{ name: t("图像"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, code: "cancelled", error: "cancelled" };
  const p = String(r.filePaths[0]);
  return { ok: true, path: p, name: path.basename(p) };
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
/* ── 二次开发（fork）来源声明 ────────────────────────────────────────────────
 * 契约见 docs/apps-market.md §八：应用身份 = **应用 id + 作者 uid**（uid 以账号 id 为准，
 * 界面显示 username）。同一应用被不同作者二次开发后各自上架成**不同 id** 的条目，
 * 条目上用 forkOf = { id, ownerId } 指回源应用（id = 源应用 id，ownerId = 源作者 uid）；
 * owner（username）只为显示，判定一律看 ownerId。
 * 空 / 非法一律当「没有声明」，绝不因此让条目读不出来。 */
function normForkOf(v) {
  if (!isObj(v)) return null;
  const id = safeAppId(v.id);
  const ownerId = String(v.ownerId == null ? "" : v.ownerId).trim();
  const owner = String(v.owner == null ? "" : v.owner).trim();
  if (!id) return null;
  return { id: id, ownerId: ownerId, owner: owner };
}
/* fork 身份键：源 id + 源作者 uid（同一源应用的不同分支靠它归组；uid 缺失时退回 username，
   绝不让一条老数据把整个归组算成「同一个源」）。 */
function forkKeyOf(f) {
  const x = normForkOf(f);
  if (!x) return "";
  return x.id + "|" + (x.ownerId || x.owner || "");
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
    /* 「开发中」标记（本机自建 / 从库里迁移过来的应用）：只由显式写入（新建应用 /
       二次开发 / 上架后写作者）落下，安装与更新一律继承原值，绝不覆盖。 */
    dev: j.dev === true,
    /* 二次开发来源（可选；原创为空）：{ id, ownerId, owner }，见 normForkOf */
    forkOf: normForkOf(j.forkOf),
    /* 设计风格（见本文件顶部 APP_STYLES）：缺字段的老应用 / 云端包一律按默认风格看待，
       写回只发生在部署时给显式风格值的那一条路径上。
       回显走 normStoredAppStyle —— 「自定义」是一个要留给界面与查询记住的值（见该函数） */
    style: normStoredAppStyle(j.style),
    styleSet: String(j.style == null ? "" : j.style).trim() !== "",
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
    /* 设计风格只写**显式给过**的那一个（部署 / 云端包没给 = 保留目录里已有的，
       老应用也绝不因为一次安装被悄悄改风味）；走 normStoredAppStyle 以留住「自定义」 */
    style: String(spec.style == null ? "" : spec.style).trim()
      ? normStoredAppStyle(spec.style)
      : normStoredAppStyle(prev.style),
    tags: tagsSrc.map(String),
    /* 「开发中」（dev）与「二次开发来源」（forkOf）：**只由显式参数改写，缺省一律继承
       目录里已有的那份** —— 安装 / 更新 / 换风格绝不能把它们抹掉（dev 抹掉 = 应用突然
       退回「库」页；forkOf 抹掉 = 分支关系在重新下载后丢失）。 */
    dev: spec.dev === true ? true : spec.dev === false ? false : prev.dev === true,
    forkOf: normForkOf(spec.forkOf) || normForkOf(prev.forkOf),
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
   模板里 {{APP_NAME}} = 应用标题（转义后替换）、{{STYLE}} = 设计风格 id；
   样式（base.css + styles/<id>.css）在注入时内联进模板的 <style> 位置，
   所以写进应用目录的入口页仍是单文件、离线可用。模板读不到（老包 / 被裁剪）时退回
   下面那份最简占位页 —— 新建应用绝不能没有入口页。 */
const DEFAULT_PAGE_TPL = path.join(__dirname, "templates", "app-default", "index.html");
const BASE_CSS_TPL = path.join(__dirname, "templates", "app-default", "base.css");
const STYLES_CSS_DIR = path.join(__dirname, "templates", "app-default", "styles");
function pageEsc(s) {
  return String(s == null ? "" : s).replace(/[<>&"]/g, (c) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
  });
}
function appStyleCss(style) {
  const id = normAppStyle(style);
  const p = path.join(STYLES_CSS_DIR, id + ".css");
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch (_) {}
  /* 风格文件缺失（老包 / 被裁剪）：退回默认那一份，保证颜色变量齐全、页面不花 */
  try {
    return fs.readFileSync(path.join(STYLES_CSS_DIR, APP_DEFAULT_STYLE + ".css"), "utf8");
  } catch (_) {
    return "";
  }
}
function defaultPageHtml(man) {
  const name = String((man && man.name) || (man && man.id) || "应用");
  /* 生成入口页用预设口径：选了「自定义」的应用先落 minimal 那一套（页面绝不花），
     真正的长相由开发会话问清风格要求后改写页面 —— 见 APP_STYLES 里 custom 那一条。 */
  const style = normAppStyle(man && man.style);
  try {
    const tpl = fs.readFileSync(DEFAULT_PAGE_TPL, "utf8");
    if (tpl.indexOf("{{APP_NAME}}") >= 0) {
      let css = "";
      try {
        css = fs.readFileSync(BASE_CSS_TPL, "utf8");
      } catch (_) {}
      css += "\n\n" + appStyleCss(style);
      return tpl
        .split("{{STYLE_CSS}}")
        .join(css)
        .split("{{APP_NAME}}")
        .join(pageEsc(name))
        .split("{{STYLE}}")
        .join(style);
    }
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
    "<p>宿主能力走 <code>window.appHost</code>：文本生成 <code>textGen / textGenStream</code>（默认关思考，要思考显式传 <code>thinking</code>；要 JSON 用脚手架 <code>AppHost.json()</code>）、图像生成 <code>imageGen</code>、本机存储 <code>storageGet / storageSet</code>、账号摘要 <code>account()</code>。</p>",
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
    /* 作者：新建 / 上架时写进 app.json 的登录账号名（空 = 没写过，界面按当前登录账号回落） */
    author: man.author,
    /* 「开发中」（本机自建 / 从库迁移来的）：库页据此过滤，开发页据此列出 —— 真源只有 app.json */
    dev: man.dev === true,
    /* 二次开发来源（可选）：{ id, ownerId, owner } */
    forkOf: man.forkOf,
    /* 来源作者（安装账本里那份）：owner = 云端 username，ownerId = 云端 uid */
    owner: String(led.owner || ""),
    ownerId: String(led.ownerId || ""),
    /* 设计风格：清单里的那一个（缺字段 = 默认极简）+ 是否显式写过（换风格对话框据此提示） */
    style: man.style,
    styleSet: !!man.styleSet,
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
    /* 目录里的核心文件（相对路径，≤10 条，已去掉 storage/ 运行期数据）：
       「二次开发」建开发节点时用它填 devFiles，与「新建应用」同一口径、不靠猜扩展名。 */
    coreFiles: (() => {
      try {
        return walkFiles(dir, "", [])
          .filter((rel) => rel.indexOf(SUB.storage + "/") !== 0)
          .slice(0, 10);
      } catch (_) {
        return [];
      }
    })(),
    broken: !readManifest(dir),
  };
}
/* 存量回填（一次性 · 幂等）：本机**没有 installed.json 安装账本**的应用 = 自己新建的
   （不是从云端下来的），补一个 dev:true —— 否则它们既不在「库」（新口径把它过滤掉）也不在
   「开发」（新口径只列开发中的），等于凭空消失。已经显式写过 dev（true / false）的一律不动，
   写完就不再写第二次（每次 list 只做一次 fs.existsSync 判定）。 */
function devBackfillOnce(root, id) {
  try {
    const dir = appDirOf(root, id);
    if (!dir || !fs.existsSync(dir)) return;
    if (fs.existsSync(installedPath(dir))) return;
    const raw = readManifest(dir);
    if (!raw || typeof raw.dev === "boolean") return;
    raw.dev = true;
    writeJson(manifestPath(dir), raw);
  } catch (_) {}
}
/* 应用清单里那几个**本机状态字段**的唯一写入口（渲染层不碰文件系统）：
   dev（开发中）/ author（作者）/ forkOf（二次开发来源）。省略的键保持原样，绝不整份重写。 */
function setAppMeta(arg) {
  const a = isObj(arg) ? arg : {};
  const id = safeAppId(a.id);
  if (!id) return bad(t("应用 id 不合法"), "bad_id");
  const { root, configured } = rootPath();
  if (!configured) return Object.assign(bad(t("尚未指定应用安装根目录"), "need_root"), { needRoot: true });
  const dir = appDirOf(root, id);
  if (!dir || !fs.existsSync(dir))
    return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: id });
  const raw = readManifest(dir);
  if (!raw) return bad(t("应用清单损坏（app.json 读不出来）：先修好它再改这些信息"), "broken_manifest");
  const patch = {};
  if (typeof a.dev === "boolean") patch.dev = a.dev;
  if (a.author !== undefined) patch.author = String(a.author == null ? "" : a.author).trim();
  if (a.forkOf !== undefined) patch.forkOf = normForkOf(a.forkOf);
  if (!Object.keys(patch).length) return bad(t("没有要写入的字段"), "no_fields");
  try {
    writeJson(manifestPath(dir), Object.assign({}, raw, patch));
  } catch (err) {
    return fail(err);
  }
  return { ok: true, id: id, patched: Object.keys(patch), app: appSummary(root, id) };
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
      devBackfillOnce(root, id);
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
 * （画布 id = 文件夹名，画布 json 里写 appId）→ 画布里建一个开发节点（画布在后台建好并
 * 居中）→ **创建后留在应用界面**：应用中心不收浮层、不返回画布，开发页切到这条新应用。
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
    /* 设计风格随新建一起落下（浮层里选的那一个；没给 = 默认极简）；
       dev:true = 「自己正在开发的」（库页据此不列它，开发页据此列它）；
       author = 当前登录账号名（渲染层传进来；未登录就不写，界面按当前登录账号回落）。 */
    const man = writeManifest(
      dir,
      { id: id, name: name, version: "1.0.0", style: a.style, dev: true, author: a.author },
      null,
    );
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
      style: normStoredAppStyle(man.style),
      dev: man.dev === true,
      author: man.author,
      dir: dir,
      root: root,
      canvasPath: canvasPathOf(dir, man.name),
      coreFiles: files.slice(0, 10),
    };
  } catch (err) {
    return fail(err);
  }
}
/* ---------------- 设计风格：换风格 + 给界面的清单 / 预览 ----------------
 *
 * 「换风格」（开发页 ⋯ 菜单那一项）＝ 按所选风格**重写应用目录的入口页**。
 * 入口页是当时从模板生成的一份独立文件，模板升级不会自动跟过去，所以这里显式重生成；
 * 用户后来在入口页里手改过的内容会被覆盖 —— 界面在确认框里已写明（契约见 STYLES.md）。
 * 只写探明在目录内的入口页，不碰 assets/ storage/、不碰画布镜像、不备份。 */
function setAppStyle(arg) {
  const a = isObj(arg) ? arg : {};
  const id = safeAppId(a.id);
  if (!id) return bad(t("应用 id 不合法"), "bad_id");
  /* 换风格：认 preset 七套 + 「自定义」（自定义同样落盘，只是入口页仍用 minimal 那套生成，
     之后由开发会话按用户答的风格要求改写 —— 见 APP_STYLES 里 custom 那一条） */
  const style = normStoredAppStyle(a.style);
  if (String(a.style == null ? "" : a.style).trim() && !APP_STYLE_IDS.includes(String(a.style).trim().toLowerCase()))
    return bad(t("未知的设计风格：") + String(a.style), "bad_style");
  let dir = "";
  let root = "";
  try {
    root = rootPath().root;
    dir = appDirOf(root, id);
  } catch (err) {
    return fail(err);
  }
  if (!dir || !fs.existsSync(dir)) return bad(t("应用目录不存在"), "no_app");
  const prev = readManifest(dir) || {};
  const man = writeManifest(dir, { style: style }, prev);
  const entry = safeEntry(man.entry) || SUB.index;
  const abs = resolveInside(dir, entry);
  if (!abs) return bad(t("入口页路径不合法"), "bad_entry");
  try {
    fs.writeFileSync(abs, defaultPageHtml(man), "utf8");
  } catch (err) {
    return fail(err);
  }
  return {
    ok: true,
    id: id,
    style: man.style,
    styleName: (APP_STYLES.find((s) => s.id === man.style) || {}).zh || man.style,
    entry: entry,
    dir: dir,
    bytes: (dirStatOf(dir) || {}).bytes || 0,
  };
}

/* 风格预览图（templates/app-default/previews/<id>.png，随包、由 scripts/app-style-previews.cjs
   从同一份模板渲染出来）读成 data URL：渲染层浮层直接 <img src> 用，不走额外协议 /
   不依赖相对路径（浮层是动态 DOM，拿不到模板目录的路径）。缺图回空串，界面回落色板。 */
function stylePreviewDataUrl(style, capBytes) {
  const id = normAppStyle(style);
  const cap = Number(capBytes) > 0 ? Number(capBytes) : 3 * 1024 * 1024;
  try {
    const p = path.join(__dirname, "templates", "app-default", "previews", id + ".png");
    if (!fs.existsSync(p)) return "";
    const st = fs.statSync(p);
    if (!st.isFile() || st.size <= 0 || st.size > cap) return "";
    return "data:image/png;base64," + fs.readFileSync(p).toString("base64");
  } catch (_) {
    return "";
  }
}
/* 给渲染层的风格清单（apps:styles）：id / 中英名 / 一句说明 / 色板 / 预览图 + 默认项。
   预览图按需带上（首次打开浮层才请求，之后渲染层自己缓存）。
   custom 那条带 custom:true（卡片据此走占位视觉 + 由选择器去问风格要求），
   它没有 preview 文件，preview 回空串、界面回落色板。 */
function appStylesPayload(withPreview) {
  return {
    ok: true,
    defaultStyle: APP_DEFAULT_STYLE,
    customStyle: APP_CUSTOM_STYLE,
    styles: APP_STYLES.map((s) => {
      const o = { id: s.id, zh: s.zh, en: s.en, why: s.why, swatch: s.swatch.slice() };
      if (s.custom === true) o.custom = true;
      /* custom 没有自己的预览图（它的长相还没定）：**不回 minimal 那张** ——
         界面按 custom:true 画占位视觉，别给用户看一张与选择无关的首屏 */
      if (withPreview && s.custom !== true) o.preview = stylePreviewDataUrl(s.id);
      return o;
    }),
  };
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
/* 接口目录（静态目录坏了时的兜底；与 appCatalogDoc() 同一份字段） */
const storeCatalogUrl = () => STORE_BASE + "/api/apps/catalog";
const catalogCachePath = () => path.join(cacheDir(), "catalog.json");

/* 条目来源基址：解析时按来源挂的（见 parseCatalogDoc 的 base）；老缓存里没有 → 退回静态目录 FEED。 */
function specBaseOf(spec) {
  const b =
    (spec && spec[SOURCE_BASE]) ||
    (spec && spec.sourceBase) ||
    ((spec && spec[SOURCE_KIND]) === "api" || (spec && spec.source) === "api" ? STORE_BASE : FEED);
  return b ? String(b) : FEED;
}
/* 允许的目录基址白名单：静态目录 + 云端接口。只做「相对路径挂到哪个基址」，
   不做投毒放行 —— 绝对地址仍要求 host 与某个允许基址相同（见 resolveZipUrl）。 */
function allowedBases() {
  return [FEED, STORE_BASE];
}
/* 这一条是不是从云端接口拉的（接口的 zipUrl / icon 是相对接口的写法） */
function isApiSpec(spec) {
  return !!(spec && spec[SOURCE_KIND] === "api");
}

/* 目录里的下载地址：只允许 http/https 且 host 命中允许基址（云端目录改不了下载源，防投毒）。
   接口目录的相对写法按接口口径解析成 /api/apps/<id>/file?format=raw。 */
function resolveZipUrl(zipUrl, base) {
  const u = String(zipUrl || "").trim();
  if (!u) return "";
  const bases = allowedBases();
  const b = base && bases.indexOf(base) >= 0 ? base : FEED;
  if (u.startsWith("/")) return b + u;
  /* 带「协议://」但不是 http(s) 的（file: / data: / javascript: …）一律拒 ——
     绝不把它当相对路径拼到目录基址后面。协议名必须是合法 scheme（以字母开头，
     数字不能当首字符），否则 `127.0.0.1:8443/x.zip` 这种「裸 host:port」会被误判成协议。 */
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(u);
  if (scheme && !/^https?$/i.test(scheme[1])) return "";
  if (!/^https?:\/\//i.test(u)) return b + "/" + u.replace(/^\.\//, "");
  try {
    const zip = new URL(u);
    if (zip.protocol !== "http:" && zip.protocol !== "https:") return "";
    const host = zip.hostname.toLowerCase();
    let hostOk = false;
    for (const one of bases) {
      try {
        if (new URL(one).hostname.toLowerCase() === host) {
          hostOk = true;
          break;
        }
      } catch {}
    }
    if (!hostOk) return "";
    return zip.toString();
  } catch {
    return "";
  }
}

/* 一条目录条目的下载地址：多版本目录优先取 versions[] 里对应那一版 ——
   **接口目录**的 versions[].zipUrl 是静态写法（<id>/<ver>.zip），静态目录里并不存在这个文件，
   必须换成接口的 /api/apps/<id>/file?version=<ver>&format=raw；静态目录则原样用。 */
function zipUrlsOf(spec) {
  const id = String((spec && spec.id) || "");
  const base = specBaseOf(spec);
  const api = isApiSpec(spec);
  const version = String((spec && spec.version) || "");
  const out = {
    zip: api
      ? base + "/api/apps/" + encodeURIComponent(id) + "/file" + (version ? "?version=" + encodeURIComponent(version) + "&format=raw" : "?format=raw")
      : resolveZipUrl(spec && spec.zipUrl, base),
    versions: {},
    icon: "",
  };
  for (const v of ((spec && spec.versions) || [])) {
    if (!v || !v.version) continue;
    out.versions[v.version] = api
      ? base + "/api/apps/" + encodeURIComponent(id) + "/file?version=" + encodeURIComponent(v.version) + "&format=raw"
      : resolveZipUrl(v.zipUrl, base);
  }
  const raw = String((spec && spec.icon) || "").trim();
  if (raw) {
    if (/^data:image\//i.test(raw)) out.icon = raw;
    else if (/^https?:\/\//i.test(raw)) out.icon = resolveZipUrl(raw, base);
    else if (api) {
      /* 接口目录的 icon 是相对接口的写法（icons/<id>.<ext> / 裸文件名）→ 统一走 /api/apps/<id>/icon。
         base 已过白名单（只有 FEED / STORE_BASE 会挂上来），不会被目录内容换成别的站。 */
      const rel = raw.replace(/^\.\//, "");
      out.icon = rel.indexOf("/") <= 0 || rel.startsWith("icons/")
        ? base + "/api/apps/" + encodeURIComponent(id) + "/icon"
        : resolveZipUrl(rel, base);
    } else out.icon = resolveZipUrl(raw, base);
  }
  return out;
}

/** 给条目挂来源基址（解析 zipUrl / icon 用它），并让渲染层原样拿到同一个基址。
    同时把按来源算好的可用 URL（urls.zip / urls.versions / urls.icon）挂上 —— 渲染层直接用，
    不重复推导（接口来源的图标 / 多版本地址与静态布局不是同一套写法）。 */
function tagSourceBase(spec, base, kind) {
  if (!spec) return spec;
  try {
    Object.defineProperty(spec, SOURCE_BASE, { value: base, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(spec, SOURCE_KIND, { value: kind, enumerable: false, writable: true, configurable: true });
  } catch {}
  spec.sourceBase = base;
  spec.source = kind;
  try {
    spec.urls = zipUrlsOf(spec);
  } catch {}
  return spec;
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
/* ── 多版本目录（docs/apps-market.md §七）──────────────────────────────────
 * 云端「一个应用收纳多个版本」时，条目带 versions[]（每项 = 一版：版本号 / 父版 / 自己的
 * zipUrl + sha256 + 字节 / 上传者 / 时间 / 版本说明）。老目录（手写清单 / 缓存 / 开关关闭的
 * 服务端）没有这个字段 —— 这里统一补成「就一个版本」，渲染层因此只有一条读路径。 */
function normVersionItem(raw, fallback) {
  const v = isObj(raw) ? raw : {};
  const fb = isObj(fallback) ? fallback : {};
  const version = String(v.version || fb.version || "0.0.0").trim() || "0.0.0";
  const parent = String(v.parentVersion == null ? "" : v.parentVersion).trim();
  return {
    version: version,
    /* 父版 = 上一版版本号；首版为空。父版自己等于自己（脏数据）按首版处理 */
    parentVersion: parent === version ? "" : parent,
    zipUrl: String(v.zipUrl || fb.zipUrl || "").trim(),
    sha256: String(v.sha256 || fb.sha256 || "").trim().toLowerCase(),
    bytes: Number(v.bytes) || Number(fb.bytes) || 0,
    uploader: String(v.uploader || fb.uploader || "").trim(),
    note: String(v.note || "").trim(),
    createdAt: Number(v.createdAt) || 0,
    declarationAt: Number(v.declarationAt) || 0,
  };
}
/* 条目 → versions[]：同版本号只留第一条（脏目录不至于画出两个同名节点） */
function normVersionsOf(s, single) {
  const list = Array.isArray(s.versions) ? s.versions : [];
  const seen = Object.create(null);
  const out = [];
  for (const raw of list) {
    const v = normVersionItem(raw, single);
    if (seen[v.version]) continue;
    seen[v.version] = 1;
    out.push(v);
  }
  if (!out.length) out.push(normVersionItem(single, null));
  return out;
}
/* 目录条目归一：认不出的条目（没有合法 id）直接丢，绝不让一条脏数据挡住整份目录 */
function normSpec(raw) {
  const s = isObj(raw) ? raw : {};
  const id = safeAppId(s.id);
  if (!id) return null;
  const title = loc(s.title || s.name);
  const min = String(s.minAppVersion || "").trim();
  const version = String(s.version || "0.0.0").trim();
  const single = {
    version: version,
    zipUrl: String(s.zipUrl || "").trim(),
    sha256: String(s.sha256 || "").trim().toLowerCase(),
    bytes: Number(s.bytes) || 0,
  };
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
    /* 多版本（§七）：latestVersion 缺省 = version；versions[] 缺省 = 就这一版 */
    owner: String(s.owner || "").trim(),
    /* 来源作者 uid（接口条目带 ownerUser.id；静态目录只有 username，那就空着）——
       「更新按钮只在同作者时出现」靠它判，判定口径见 docs/apps-market.md §八。 */
    ownerId: String(s.ownerId || (isObj(s.ownerUser) && s.ownerUser.id) || "").trim(),
    /* 二次开发来源（可选）：{ id, ownerId, owner } —— 同一源应用的不同作者分支按它归组 */
    forkOf: normForkOf(s.forkOf),
    latestVersion: String(s.latestVersion || version).trim() || version,
    versions: normVersionsOf(s, single),
  };
}
function parseCatalogDoc(doc, base, kind) {
  const d = isObj(doc) ? doc : {};
  const list = Array.isArray(d.apps) ? d.apps : Array.isArray(d.list) ? d.list : [];
  const b = base || FEED;
  const k = kind || "static";
  const apps = [];
  for (const item of list) {
    const spec = normSpec(item);
    if (spec) apps.push(tagSourceBase(spec, b, k));
  }
  return { version: Number(d.version) || 1, updatedAt: String(d.updatedAt || ""), apps: apps };
}
/* 装上 / 可更新状态：目录条目 × 本机目录 */
function attachInstalled(specs) {
  const have = Object.create(null);
  for (const s of listApps().apps) if (s.id) have[s.id] = s;
  return (Array.isArray(specs) ? specs : []).map((spec) => {
    const cur = have[spec.id] || null;
    const merged = Object.assign({}, spec, {
      installed: !!cur,
      installedVersion: cur ? cur.version : "",
      installedAt: cur ? cur.installedAt : 0,
      dir: cur ? cur.dir : "",
      /* 本机那一份的状态（渲染层据此判「开发中」「同作者」「分支已装」）：
         localDev = 开发中 · localAuthor = 本机 app.json 里的作者 ·
         localOwner/localOwnerId = 安装账本里的来源作者（username / uid）· localForkOf = 本机声明。 */
      localDev: !!cur && cur.dev === true,
      localAuthor: cur ? String(cur.author || "") : "",
      localOwner: cur ? String(cur.owner || "") : "",
      localOwnerId: cur ? String(cur.ownerId || "") : "",
      localForkOf: (cur && cur.forkOf) || null,
      updateAvailable: !!cur && verCmp(spec.version, cur.version) > 0,
    });
    /* Object.assign 会把 Symbol 与不可枚举的来源标记丢掉 —— 这里重新挂上，
       让渲染层与安装流程拿到的每一条都带着「来源基址」，不必再回推。 */
    return tagSourceBase(merged, specBaseOf(spec), isApiSpec(spec) ? "api" : "static");
  });
}
function readCatalogCache() {
  return readJson(catalogCachePath(), null);
}
function writeCatalogCache(sourceUrl, doc, base, kind) {
  try {
    writeJson(catalogCachePath(), {
      fetchedAt: Date.now(),
      sourceUrl: sourceUrl,
      sourceBase: base,
      sourceKind: kind,
      doc: doc,
    });
  } catch {}
}
function catalogFromCache(c, remoteError) {
  const doc = (c && c.doc) || {};
  const parsed = parseCatalogDoc(doc, c && c.sourceBase, c && c.sourceKind);
  return {
    ok: true,
    source: "cache",
    fetchedAt: Number(c && c.fetchedAt) || 0,
    sourceUrl: String((c && c.sourceUrl) || catalogUrl()),
    sourceBase: String((c && c.sourceBase) || FEED),
    apps: attachInstalled(parsed.apps),
    appVersion: String(getAppVersion() || ""),
    remoteError: remoteError,
  };
}
/* 静态目录（首选入口）：拉不到 / 是空目录都算失败 —— 空目录正是「部署链把线上目录刷空」
   那类事故的样子，必须让调用方回退接口目录，而不是把「一条应用都没有」当结论。 */
async function fetchRemoteCatalog() {
  const buf = await fetchBuffer(catalogUrl(), null, MAX_CATALOG);
  const doc = JSON.parse(buf.toString("utf8"));
  if (!isObj(doc) || !(Array.isArray(doc.apps) || Array.isArray(doc.list))) throw new Error("bad_catalog");
  const parsed = parseCatalogDoc(doc, FEED, "static");
  if (!parsed.apps.length) throw new Error("empty_catalog（静态目录 0 条）");
  writeCatalogCache(catalogUrl(), doc, FEED, "static");
  return parsed;
}
/* 接口目录（兜底）：服务端 appCatalogDoc() 的同一份字段，永远与库同步。 */
async function fetchApiCatalog() {
  const buf = await fetchBuffer(storeCatalogUrl(), null, MAX_CATALOG);
  const doc = JSON.parse(buf.toString("utf8"));
  if (!isObj(doc) || !(Array.isArray(doc.apps) || Array.isArray(doc.list))) throw new Error("bad_catalog");
  const parsed = parseCatalogDoc(doc, STORE_BASE, "api");
  writeCatalogCache(storeCatalogUrl(), doc, STORE_BASE, "api");
  return parsed;
}
/* 云端目录：静态 → 接口 → 本机缓存 → 空列表。
   每一层都记进日志（source / remoteError），排查「应用库没连上云端」时一眼能看出断在哪一层。 */
async function loadCatalog() {
  const errors = [];
  try {
    const remote = await fetchRemoteCatalog();
    return {
      ok: true,
      source: "remote",
      fetchedAt: Date.now(),
      sourceUrl: catalogUrl(),
      sourceBase: FEED,
      apps: attachInstalled(remote.apps),
      appVersion: String(getAppVersion() || ""),
    };
  } catch (err) {
    errors.push("static: " + ((err && err.message) || err));
  }
  try {
    const api = await fetchApiCatalog();
    const out = {
      ok: true,
      source: "api",
      fetchedAt: Date.now(),
      sourceUrl: storeCatalogUrl(),
      sourceBase: STORE_BASE,
      apps: attachInstalled(api.apps),
      appVersion: String(getAppVersion() || ""),
      remoteError: errors.join(" · "),
    };
    if (!out.apps.length) throw new Error("empty_catalog（接口目录 0 条）");
    console.log(
      "[apps-store] 静态目录不可用（" + errors.join(" · ") + "）→ 已回退云端接口目录：" +
        storeCatalogUrl() + "（" + out.apps.length + " 个应用）",
    );
    return out;
  } catch (err) {
    errors.push("api: " + ((err && err.message) || err));
  }
  const c = readCatalogCache();
  if (c && c.doc) {
    const out = catalogFromCache(c, errors.join(" · "));
    console.warn("[apps-store] 云端目录拉不到（" + out.remoteError + "）→ 显示本机缓存：" + out.sourceUrl);
    return out;
  }
  console.warn("[apps-store] 云端目录拉不到、本机也没有缓存：" + errors.join(" · "));
  return {
    ok: true,
    source: "empty",
    fetchedAt: 0,
    sourceUrl: catalogUrl(),
    sourceBase: FEED,
    apps: [],
    appVersion: String(getAppVersion() || ""),
    remoteError: errors.join(" · "),
  };
}
/* 找一个目录条目：先缓存、再远端（安装时云端刚更新过也能装上） */
async function findSpec(id) {
  const c = readCatalogCache();
  if (c && c.doc) {
    const hit = parseCatalogDoc(c.doc, c.sourceBase, c.sourceKind).apps.find((a) => a.id === id);
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
  if (/^version_not_in_catalog/.test(s)) return "云端目录里找不到这个版本（作者可能已删除该版本）";
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
    let spec = await findSpec(id);
    if (!spec) throw new Error("not_in_catalog");
    /* 下载地址按**来源**解析（静态目录 = FEED + 相对路径；接口目录 = <store>/api/apps/<id>/file|icon）。
       必须在选版**之前**算：接口目录的 versions[].zipUrl 是静态写法，静态目录里并不存在那个文件。 */
    const urls = zipUrlsOf(spec);
    /* 选版下载（§七）：渲染层点了版本树里的某一版 → 只换 zipUrl / sha256 / version，
       其余（entry / window / tags…）仍取应用条目；目录里没有那一版就如实报错。 */
    const wantVersion = String(a.version || "").trim();
    if (wantVersion) {
      const hit = (spec.versions || []).find((v) => v.version === wantVersion);
      if (!hit) throw new Error("version_not_in_catalog");
      spec = Object.assign({}, spec, {
        version: hit.version,
        zipUrl: urls.versions[hit.version] || hit.zipUrl,
        sha256: hit.sha256,
        bytes: hit.bytes || spec.bytes,
      });
    } else if (urls.zip) {
      spec = Object.assign({}, spec, { zipUrl: urls.zip });
    }
    if (!spec.compatible) throw new Error("need_app_update");
    const zipUrl = resolveZipUrl(spec.zipUrl, specBaseOf(spec));
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
      /* 覆盖安装 / 更新前先读一把**本机**清单：dev（开发中）与 forkOf（二次开发来源）只存在于
         本机目录里，云端包与目录都没有 —— 它们必须在 removePayload 抹掉 app.json 之前取到，
         否则一次更新就会让应用从「开发」页退回「库」页、分支关系也跟着丢。 */
      const keepMan = readManifest(targetDir) || {};
      removePayload(targetDir);
      /* 包内自带的 app.json（导出时写进去的）当上一份清单：目录条目补它缺的字段，
         目录条目没有的（自绘应用）也留得住 */
      const zipMan = readJson(path.join(srcDir, SUB.manifest), null);
      /* 账本只记**这次装进去的载荷**（解包目录里的文件 + 我们写的 app.json / 补的入口页）：
         storage/store.json 与该应用自己的画布不在其中 —— 下次覆盖 / 更新安装绝不会把它们删掉。 */
      const payload = walkFiles(srcDir, "", []);
      copyDirRecursive(srcDir, targetDir);
      const man = writeManifest(
        targetDir,
        Object.assign({}, spec, {
          dev: keepMan.dev === true,
          forkOf: keepMan.forkOf || null,
        }),
        zipMan || keepMan,
      );
      ensureStructure(targetDir, man);
      const ledger = payload.slice();
      for (const rel of [SUB.manifest, man.entry]) if (!ledger.includes(rel)) ledger.push(rel);
      writeJson(installedPath(targetDir), {
        schema: SCHEMA,
        id: targetId,
        version: man.version,
        source: zipUrl,
        sha256: sha256(zipBuf),
        /* 来源作者（「更新按钮只在同作者时出现」与「分支作者」都靠它判）：
           owner = 云端 username（显示用），ownerId = 云端 uid（判定用，见 docs/apps-market.md §八）。 */
        owner: String(spec.owner || ""),
        ownerId: String(spec.ownerId || ""),
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
  writeModelSelection(sid, MODEL_AUTO); /* 卸载顺手清掉该应用的模型选择（不留孤儿条目） */
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
    if (fs.existsSync(manAbs)) {
      /* 包里那份 app.json **去掉本机的「开发中」标记（dev）**：它是本机状态，跟着包跑出去
         会让下载者（或自己在另一台机器上）把这个应用当成「正在开发」而不列进「库」。
         author 与 forkOf（二次开发来源）照常随包走 —— 契约见 docs/apps-market.md §八。 */
      const packMan = Object.assign({}, readManifest(dir) || {});
      delete packMan.dev;
      entries.push({ name: SUB.manifest, data: Buffer.from(JSON.stringify(packMan, null, 2), "utf8") });
    }
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

/* ---------------- 上架辅助：拍应用窗口 + 现打包读回 base64（§七） ----------------
 *
 * 上架窗（renderer/app-publish.js）默认要一张「应用窗口截图」，而渲染层拿不到别的窗口的像素 ——
 * 只能由主进程抓。两者都守同一条纪律：**渲染层不碰文件系统、不自己拼路径**，只拿回执里的绝对路径 /
 * base64。截图落 <数据目录>/captures/（与 main.js 桌面截图同目录），绝不落应用文件夹。
 */

/* 拍该应用**自己**的窗口（不是整屏）。窗口没开 / 最小化时如实报错让用户先点「启动」，
   绝不偷偷把窗口打开或还原 —— 用户没让你动他的窗口。
   默认截图会被上架窗当**图标**上传（服务端图标上限 500KB，只收 png/jpeg/webp）：整窗原图动辄
   超过这个数，所以这里按图标口径收一版 —— 先缩到 512 宽出 PNG，仍超 500KB 再转 JPEG(85)。 */
async function shotAppWindow(id) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const w = appWins.get(sid);
  if (!w || w.isDestroyed()) return bad(t("这个应用的窗口还没打开：先点「启动」，再回来拍图"), "not_open");
  if (w.isMinimized()) return bad(t("应用窗口已最小化：先还原窗口，再回来拍图"), "minimized");
  try {
    const img = await w.webContents.capturePage();
    if (!img || img.isEmpty()) return bad(t("截图为空：应用窗口可能还没画出来，稍等一下再拍"), "empty_shot");
    const full = img.toPNG();
    if (!full || !full.length) return bad(t("截图为空：应用窗口可能还没画出来，稍等一下再拍"), "empty_shot");
    const size = img.getSize ? img.getSize() : { width: 0, height: 0 };
    /* 版本 ①：原图（够小就用它，最清晰） */
    let buf = full;
    let ext = "png";
    if (buf.length > ICON_SHOT_MAX_BYTES) {
      /* 版本 ②：缩到 512 宽（等比）的 PNG */
      let small = null;
      try {
        const sw = Math.max(1, Math.min(512, Number(size.width) || 512));
        small = img.resize({ width: sw, quality: "good" }).toPNG();
      } catch (_) {
        small = null;
      }
      if (small && small.length) {
        buf = small;
      }
      /* 版本 ③：仍超上限 → JPEG(85)，图标口径允许 jpeg */
      if (buf.length > ICON_SHOT_MAX_BYTES) {
        try {
          const jpg = (small ? img.resize({ width: Math.max(1, Math.min(512, Number(size.width) || 512)), quality: "good" }) : img).toJPEG(85);
          if (jpg && jpg.length && jpg.length < buf.length) {
            buf = jpg;
            ext = "jpg";
          }
        } catch (_) {}
      }
    }
    const out = path.join(mk(path.join(String(getDataDir() || ""), "captures")),
      "app-" + sid + "-" + Date.now().toString(36) + "." + ext);
    fs.writeFileSync(out, buf);
    return {
      ok: true, id: sid, path: out, file: path.basename(out), bytes: buf.length, ext: ext,
      width: Number(size.width) || 0, height: Number(size.height) || 0,
      scaled: buf.length !== full.length,
    };
  } catch (err) {
    return bad(t("拍应用窗口失败：") + ((err && err.message) || err), "shot_failed");
  }
}

/* 上架用：**现打一份** zip 再读回 base64（与 exportZip 同一份打包实现：只含 app.json +
   入口页 + assets，不含画布）。现打现读 = 绝不会把上一轮导出的旧包传上去。 */
function readPackBase64(id) {
  const r = exportZip(id);
  if (!r || r.ok === false) return r || bad(t("打包失败"), "pack_failed");
  try {
    const buf = fs.readFileSync(r.path);
    return {
      ok: true,
      id: r.id,
      name: r.name,
      version: r.version,
      path: r.path,
      file: r.file,
      files: r.files,
      bytes: buf.length,
      sha256: sha256(buf),
      base64: buf.toString("base64"),
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
    const cat = spec && spec.doc ? parseCatalogDoc(spec.doc, spec.sourceBase, spec.sourceKind) : null;
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
  /* 麦克风权限（需求：应用里也能用内置 ASR 听写）：Electron 默认拒绝一切权限请求，
     而主窗口那条 handler 只挂在**主窗口自己的会话**上，应用窗口拿不到 —— 这里按窗口补一份。
     口径与主窗口一致且更窄：只放行 media 一类，只认本机页（file: / mtnode-preview:），
     通知 / 定位 / 剪贴板读等仍走 Electron 默认拒绝。 */
  {
    const MEDIA_PERMISSIONS = new Set(["media", "audioCapture", "videoCapture"]);
    const isLocalPage = (url) => !/^https?:/i.test(String(url || ""));
    /* 会话取法容错：真 Electron 里 webContents.session 恒在；冒烟里的替身窗口可能没有 session，
       那种情况下退回默认会话（拿不到会话就当权限这条不生效，绝不因此抛异常把窗口开不出来）。 */
    let ses = null;
    try {
      ses = (w.webContents && w.webContents.session) || null;
    } catch {}
    if (!ses) {
      try {
        ses = session.defaultSession;
      } catch {}
    }
    if (ses && typeof ses.setPermissionRequestHandler === "function") {
      ses.setPermissionRequestHandler((wc, permission, callback, details) => {
        const url = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || "";
        callback(MEDIA_PERMISSIONS.has(permission) && isLocalPage(url));
      });
      ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
        const url = (details && details.requestingUrl) || requestingOrigin || "";
        return MEDIA_PERMISSIONS.has(permission) && isLocalPage(url);
      });
    }
  }
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

/* ---------------- appHost：语音转写（官方本地 SenseVoice，跑在 dsh 运行时里） ----------------
 *
 * 应用窗口侧的三个能力（需求：该 asr 能力也要允许被应用直接调用）：
 *   pickAudio()                 → 系统选音频框，只回路径（用户亲自选的那一次才生效）
 *   transcribe({ path|url, … }) → 读盘 → base64 WAV → dsh 语音通道 → { ok, text }
 *   mic()                       → 只是**能力探测**：应用窗口的麦克风权限由宿主按会话
 *                                 （见 main.js 的 APP 窗口 permission handler）放行，
 *                                 真正的采集在应用页里用 getUserMedia + AudioContext 做
 *   status() / prepare()        → 模型现况与首次下载权重（进度经 apps:hostSpeechState 推）
 *
 * 路径纪律：transcribe 只认「本机存在 + 用户在本应用里亲自选过（pickAudio）或应用数据文件夹里」
 * 的音频；应用传别的路径一律拒绝。**不给任意路径读盘能力**（那等于把文件系统开给应用页）。
 */
let getDshForSpeech = null;
let getAppDataDirForSpeech = null;
/** 每个应用 id 记住用户在系统框里亲选过的音频路径（规范化小写） */
const pickedAudioByApp = new Map();

async function pickAudioForApp(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const parent = BrowserWindow.fromWebContents(e.sender) || getMainWin();
  const r = await dialog.showOpenDialog(parent || undefined, {
    title: t("选择音频"),
    properties: ["openFile"],
    filters: [
      { name: t("音频"), extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wma", "webm"] },
    ],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0])
    return { ok: false, code: "cancelled", error: "cancelled" };
  const p = String(r.filePaths[0]);
  const set = pickedAudioByApp.get(own.id) || new Set();
  set.add(path.resolve(p).toLowerCase());
  pickedAudioByApp.set(own.id, set);
  return { ok: true, path: p, name: path.basename(p) };
}
/** 这一条路径允不允许读：亲选过，或在**本应用自己的数据文件夹**里（应用自己生成的录音等） */
function audioPathAllowed(appId, p) {
  const abs = path.resolve(String(p || ""));
  if (!abs) return false;
  const set = pickedAudioByApp.get(appId);
  if (set && set.has(abs.toLowerCase())) return true;
  try {
    const dir = getAppDataDirForSpeech ? String(getAppDataDirForSpeech(appId) || "") : "";
    if (dir && abs.toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)) return true;
  } catch {}
  return false;
}
/** 路径 / file: URL 归一成绝对路径（应用侧给哪个都行） */
function pathOfAudioArg(v) {
  const s = String(v || "");
  if (!s) return "";
  try {
    if (/^file:/i.test(s)) return decodeURIComponent(new URL(s).pathname.replace(/^\//, "").replace(/\//g, path.sep));
  } catch {}
  return s;
}
function base64OfAudio(abs, maxBytes) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return bad(t("音频文件不存在或已被移动"), "audio_missing");
  }
  if (!st.isFile()) return bad(t("音频文件不存在或已被移动"), "audio_missing");
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : 256 * 1024 * 1024;
  if (st.size > cap) return bad(t("音频超过上限"), "too_large");
  try {
    return { ok: true, base64: fs.readFileSync(abs).toString("base64"), bytes: st.size };
  } catch (err) {
    return fail(err);
  }
}
/** 语音快照剪成给应用看的形状（不带内部字段；应用只关心「能不能用 / 下没下完」） */
function speechStatusForApp(raw) {
  const st = isObj(raw) ? raw : {};
  if (st.ok === false) return { ok: false, error: String(st.error || ""), code: "speech_unavailable" };
  const providers = Array.isArray(st.providers) ? st.providers : [];
  const selection = isObj(st.selection) ? st.selection : {};
  const cur =
    providers.find((p) => String(p.id) === String(selection.providerId || "")) || providers[0] || null;
  const prep = isObj(cur && cur.preparation) ? cur.preparation : {};
  const phase = String(prep.phase || "unprepared");
  return {
    ok: true,
    available: providers.length > 0,
    providerId: String((cur && cur.id) || selection.providerId || ""),
    providerName: String((cur && cur.name) || ""),
    phase: phase,
    ready: phase === "ready" || phase === "standby",
    downloading: phase === "downloading" || phase === "checking" || phase === "loading",
    completedBytes: Number(prep.completedBytes) || 0,
    totalBytes: Number(prep.totalBytes) || 0,
    message: String(prep.message || ""),
    languages: Array.isArray(cur && cur.languages) ? cur.languages.slice(0, 16) : [],
    language: String(selection.language || ""),
  };
}
/** 语音运行时按 workspace 记账（网关 `handleSpeech` 硬性要求 workspace，缺了直接回
 *  「缺少 workspace」）：应用窗口没有画布，统一用**本应用的数据文件夹**当工作区。
 *  探测 / 准备 / 转写三条路必须同源 —— 否则「探测」落在另一台运行时上，
 *  界面就会把「本机语音其实好着」误报成「dsh 没起来」（曾实测到的那条假警报）。 */
function speechWorkspaceForApp(appId) {
  try {
    if (typeof getAppDataDirForSpeech === "function") {
      const dir = String(getAppDataDirForSpeech(appId) || "");
      if (dir) return dir;
    }
  } catch {}
  return "";
}
/** 给「探活」这类调用加一道兜底超时：超了就回 fallback，绝不把界面挂死。
 *  （dsh 语音走 IPC 到主进程再到网关，网关那侧自己有 8 秒等通道的窗口。） */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(typeof fallback === "function" ? fallback() : fallback);
    }, Math.max(1000, Number(ms) || 30000));
    Promise.resolve(promise).then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: String((err && err.message) || err) });
      },
    );
  });
}
/** 统一的 dsh 语音调用：固定补上 workspace，失败一律 { ok:false, error, code }。
 *  timeoutNote = 探活超时的中文说明：网关那侧的超时文案对用户没有可操作性。 */
async function speechCallForApp(appId, payload, timeoutNote) {
  const ws = speechWorkspaceForApp(appId);
  const raw = await getDshForSpeech()
    .speech(Object.assign({}, payload, ws ? { workspace: ws } : {}))
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  if (raw && raw.ok === false && timeoutNote) {
    return Object.assign({}, raw, { error: raw.error || timeoutNote });
  }
  return raw;
}
async function hostAsrStatus(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  if (typeof getDshForSpeech !== "function") return bad(t("语音服务不可用"), "no_dsh");
  /* 探活不挂死界面：网关那侧「运行时冷起 + 等语音通道」最多约 8 秒，
     超过就回一句能照做的中文（前端据此显示「语音引擎还在启动，稍后再试」）。 */
  const raw = await withTimeout(
    speechCallForApp(own.id, { action: "state" }),
    30000,
    { ok: false, error: t("语音引擎还在启动，稍后再试"), code: "speech_timeout" },
  );
  return speechStatusForApp(raw);
}
async function hostAsrPrepare(e, opts) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  if (typeof getDshForSpeech !== "function") return bad(t("语音服务不可用"), "no_dsh");
  const raw = await speechCallForApp(own.id, {
    action: "prepare",
    ...(opts && opts.providerId ? { providerId: String(opts.providerId) } : {}),
    ...(opts && opts.downloadSource ? { downloadSource: String(opts.downloadSource) } : {}),
  });
  /* prepare 立即返回（真正的下载在运行时里跑），这里回的是「开始下载那一刻」的快照 */
  return speechStatusForApp(raw);
}
async function hostAsrTranscribe(e, opts) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  if (typeof getDshForSpeech !== "function") return bad(t("语音服务不可用"), "no_dsh");
  const o = isObj(opts) ? opts : {};
  /* 两条入口：① 应用自己录好的 16k 单声道 PCM16 WAV（base64，不落盘、不经过文件系统）；
     ② 本机音频路径（只认用户在本窗口亲选过 / 在本应用数据文件夹里的那一份）。 */
  const inlineB64 = String(o.base64 || "").replace(/\s+/g, "").replace(/^data:[^,]+,/, "");
  let b64 = null;
  let absPath = "";
  if (inlineB64) {
    if (!/^[A-Za-z0-9+/=]+$/.test(inlineB64)) return bad(t("音频数据不是合法的 base64"), "bad_audio");
    if (inlineB64.length > 64 * 1024 * 1024)
      return bad(t("音频超过上限（base64 64MB）"), "too_large");
    b64 = { ok: true, base64: inlineB64, bytes: Math.floor((inlineB64.length * 3) / 4) };
  } else {
    absPath = pathOfAudioArg(o.path || o.url || "");
    if (!absPath) return bad(t("未选择音频"), "no_audio");
    if (!audioPathAllowed(own.id, absPath))
      return bad(
        t("只允许转写你在本应用里选过的音频（用 asrPickAudio 选，或先放进应用数据文件夹）"),
        "path_denied",
      );
    b64 = base64OfAudio(absPath, o.maxBytes);
    if (b64.ok !== true) return b64;
  }
  /* 语音运行时按 workspace 记账：应用窗口没有画布，用**本应用的数据文件夹**当工作区
     （与 asrStatus / asrPrepare 同源；模型权重缓存与工作区同源，拿不到就退回语音内核的默认档）。 */
  const raw = await speechCallForApp(own.id, {
    action: "transcribe",
    audio: b64.base64,
    ...(o.language ? { language: String(o.language) } : {}),
    ...(o.providerId ? { providerId: String(o.providerId) } : {}),
  });
  if (!raw || raw.ok === false)
    return { ok: false, code: "speech_failed", error: String((raw && raw.error) || t("语音转写失败")) };
  return {
    ok: true,
    text: String(raw.text || ""),
    audioSeconds: Number(raw.audioSeconds) || 0,
    inferenceSeconds: Number(raw.inferenceSeconds) || 0,
    bytes: b64.bytes,
    path: absPath,
  };
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
/* 可用文本服务商（按配置里的顺序 = 用户在设置里拖出来的优先级） */
function usableTextProviders() {
  const usable = (p) => !!String(p.apiKey || "").trim() && !!String(p.baseUrl || "").trim();
  return providersFromConfig().filter((p) => String(p.type || "") === "text_openai" && usable(p));
}
/* 默认服务商：文本优先 DeepSeek 官方（本机配置里 host 含 deepseek 的那条），否则第一条可用文本；
   图像优先第一条 image_* 服务商。应用窗口**不能**指定服务商 / Key —— 只能给提示词与模型 id。 */
function providerFor(kind) {
  const list = providersFromConfig();
  const usable = (p) => !!String(p.apiKey || "").trim() && !!String(p.baseUrl || "").trim();
  if (kind === "image") return list.filter((p) => /^image_/.test(String(p.type || "")) && usable(p))[0] || null;
  const texts = usableTextProviders();
  return texts.find((p) => isDeepseekHost(p.baseUrl)) || texts[0] || null;
}
function normRole(v) {
  const r = String(v || "").trim().toLowerCase();
  return r === "system" || r === "assistant" || r === "user" ? r : "";
}

/* ---------------- appHost：模型清单与「继承 MTNode 的模型选择」 ----------------
 *
 * 应用窗口不能碰服务商与 Key（那是主进程的事），但**可以**在 MTNode 已配置的模型里挑一个：
 *   hostModels()  列出全部已配置文本模型（按设置里的优先级，跨服务商）+ 首项「跟随默认」；
 *                每项带 vision（目录 input:image ∩ 服务商 vision 开关，拿不到目录时不误报）；
 *   hostModel()   当前生效的选择（auto / 具体模型 id）
 *   hostSetModel()改选择（只认清单里的 id 或 "auto"），**按应用 id 持久化**，关窗重启还记得。
 * 选择存在 <数据目录>/apps-models.json（宿主侧文件，不是应用数据 —— 应用重写代码 / 清数据都不丢）。
 * ─────────────────────────────────────────────────────────────────────────── */

const modelsFilePath = () => path.join(String(getDataDir() || ""), "apps-models.json");
function readModelSelections() {
  const j = readJson(modelsFilePath(), null);
  return isObj(j) ? j : {};
}
function readModelSelection(id) {
  const v = readModelSelections()[String(id || "")];
  return typeof v === "string" ? v.trim() : "";
}
function writeModelSelection(id, model) {
  const aid = String(id || "");
  if (!aid) return;
  try {
    const all = readModelSelections();
    const next = String(model || "").trim();
    if (!next || next === MODEL_AUTO) delete all[aid];
    else all[aid] = next;
    writeJson(modelsFilePath(), all); /* 原子写（config-providers.js 的 tmp + rename） */
  } catch (err) {
    console.warn("[apps-models] 写入失败：" + ((err && err.message) || err));
  }
}
/* 目录里标了「能识图」的模型 id 集合（渲染层 settings 与主窗口同一判据：目录条目 input 含 image）。
   目录由 main.js 注入（dsh 的 providerCatalog，与渲染层 ensureProviderCatalog 同源）；
   拿不到目录时返回 null = 未知（此时只认服务商级 vision 开关，不把模型误标成不支持识图）。 */
function visionCatalogIds() {
  let cat = null;
  try {
    cat = typeof providerCatalog === "function" ? providerCatalog() : null;
  } catch {
    cat = null;
  }
  if (!isObj(cat)) return null;
  const ids = new Set();
  const eat = (arr) => {
    for (const m of Array.isArray(arr) ? arr : []) {
      if (isObj(m) && m.id && Array.isArray(m.input) && m.input.includes("image")) ids.add(String(m.id));
    }
  };
  eat(cat.deepseek);
  for (const p of Array.isArray(cat.piai) ? cat.piai : []) eat(p && p.models);
  return ids;
}
function modelVisionOf(provider, modelId) {
  if (!provider || provider.vision !== true) return false;
  const ids = visionCatalogIds();
  if (!ids) return true; /* 目录缺席：信服务商级开关（与 buildRequestSpec 的下发判据一致） */
  return ids.has(String(modelId || ""));
}
/* MTNode 已配置的全部文本模型（跨服务商，顺序 = 设置里的优先级；同一 id 只留第一个） */
function listTextModels() {
  const out = [];
  const seen = new Set();
  for (const p of usableTextProviders()) {
    for (const id of modelIdsOf(p)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id: id,
        label: id,
        providerId: String(p.id || ""),
        providerName: String(p.name || p.id || ""),
        vision: modelVisionOf(p, id),
      });
    }
  }
  return out;
}
/* 本次请求实际下发的模型：具体 id > 该应用存过的选择 > auto（带图挑第一个可用视觉模型） */
function resolveModelFor(appId, providerDefaultId, modelId, hasImages) {
  const pick = String(modelId == null ? "" : modelId).trim();
  const saved = readModelSelection(appId);
  const want = pick && pick !== MODEL_AUTO ? pick : saved || "";
  if (!want) {
    if (!hasImages) return { modelId: providerDefaultId, provider: null, auto: true };
    const list = listTextModels().filter((m) => m.vision);
    if (!list.length) return { error: "no_vision" };
    return { modelId: list[0].id, providerId: list[0].providerId, auto: true };
  }
  const hit = listTextModels().find((m) => m.id === want);
  if (!hit) return { error: "bad_model" };
  return { modelId: hit.id, providerId: hit.providerId, auto: false };
}
/* 可选模型清单（首项 = 跟随 MTNode 默认）：无可用服务商也照常回，由应用决定怎么提示 */
function hostModelsPayload(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const models = listTextModels();
  const saved = readModelSelection(own.id);
  const sel = saved && models.some((m) => m.id === saved) ? saved : MODEL_AUTO;
  const fallback = providerFor("text");
  return {
    ok: true,
    models: [{ id: MODEL_AUTO, label: "", providerId: "", providerName: "", vision: false, auto: true }].concat(models),
    selected: sel,
    hasAny: models.length > 0,
    hasVision: models.some((m) => m.vision),
    defaultModel: fallback ? modelIdsOf(fallback)[0] || "" : "",
  };
}
function hostModelGet(e) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const models = listTextModels();
  const saved = readModelSelection(own.id);
  const fallback = providerFor("text");
  return {
    ok: true,
    selected: saved && models.some((m) => m.id === saved) ? saved : MODEL_AUTO,
    hasAny: models.length > 0,
    hasVision: models.some((m) => m.vision),
    defaultModel: fallback ? modelIdsOf(fallback)[0] || "" : "",
  };
}
function hostModelSet(e, arg) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const want = String((isObj(arg) && arg.model) || "").trim();
  if (!want) return bad(t("缺少模型 id"), "bad_model");
  if (want !== MODEL_AUTO && !listTextModels().some((m) => m.id === want))
    return bad(t("该模型不在 MTNode 已配置的模型清单里"), "bad_model");
  writeModelSelection(own.id, want);
  return hostModelGet(e);
}

/* ---------------- appHost：多模态消息（文本 + 图像） ----------------
 *
 * content 白名单：字符串，或 [{type:"text"},{type:"image_url",image_url:{url:<路径|dataURL>}}]。
 * 图像交给主进程读盘 / 解码 / 缩放（与画布节点同一份 shrinkImage 内核，长边上限 1080），
 * 页面拿不到任意文件内容 —— 只能通过它自己给的路径或 dataURL 要求「把这张图发给模型」。
 * 上限：单条消息 8 张、单次请求原始字节合计 10MB；超限 / 非图 / 读不出回结构化错误码。
 * ─────────────────────────────────────────────────────────────────── */

/* 把 dataURL 变成 {buf, ext}（校验 mime 属于支持的图像类型） */
function decodeImageDataUrl(s) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(s || "").trim());
  if (!m) return { error: "bad_image" };
  const mime = m[1].toLowerCase();
  const ext = Object.keys(IMG_EXT_TYPES).find((k) => IMG_EXT_TYPES[k] === mime);
  if (!ext) return { error: "bad_image" };
  let buf = null;
  try {
    buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  } catch {}
  if (!buf || !buf.length) return { error: "bad_image" };
  return { buf: buf, ext: ext === "jpeg" ? "jpg" : ext };
}
/* 一张图 → { url: dataURL, bytes: 原始字节数 }；失败回 { error }（错误码即契约） */
function imagePartUrl(raw, quota) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { error: "bad_image" };
  let buf = null;
  let ext = "";
  if (/^data:/i.test(s)) {
    const d = decodeImageDataUrl(s);
    if (d.error) return { error: d.error };
    buf = d.buf;
    ext = d.ext;
  } else {
    if (!path.isAbsolute(s)) return { error: "bad_image" };
    ext = String(path.extname(s)).slice(1).toLowerCase();
    if (!IMG_EXT_TYPES[ext]) return { error: "bad_image" };
    if (!fs.existsSync(s)) return { error: "bad_image" };
    try {
      if (!fs.statSync(s).isFile()) return { error: "bad_image" };
      buf = fs.readFileSync(s);
    } catch {
      return { error: "bad_image" };
    }
  }
  if (!buf || !buf.length) return { error: "bad_image" };
  quota.bytes += buf.length;
  if (quota.bytes > MAX_MSG_IMAGE_BYTES) return { error: "too_large" };
  /* 与画布节点同一份内核：长边 ≤ 1080 等比缩放，无法解码 / 已达标时原样下发 */
  let out = { buf: buf, ext: ext };
  try {
    if (typeof shrinkImage === "function") out = shrinkImage(buf, ext);
  } catch {}
  const mime = IMG_EXT_TYPES[String(out.ext || ext).toLowerCase()] || IMG_EXT_TYPES[ext] || "image/png";
  return { url: "data:" + mime + ";base64," + out.buf.toString("base64"), bytes: buf.length };
}
/* 单条消息的 content：字符串原样收；数组按 OpenAI 多模态形状重建（不认识的分片丢弃） */
function normContent(content, quota) {
  if (typeof content === "string") return { content: content.slice(0, MAX_PROMPT) };
  if (!Array.isArray(content)) return { content: "" };
  const parts = [];
  let images = 0;
  for (const part of content) {
    if (!isObj(part)) continue;
    if (part.type === "text") {
      const text = String(part.text == null ? "" : part.text);
      if (text) parts.push({ type: "text", text: text.slice(0, MAX_PROMPT) });
      continue;
    }
    if (part.type !== "image_url") continue;
    const src = isObj(part.image_url) ? part.image_url.url : part.image_url;
    const one = imagePartUrl(src, quota);
    if (one.error) return { error: one.error };
    images += 1;
    if (images > MAX_MSG_IMAGES) return { error: "too_many_images" };
    parts.push({ type: "image_url", image_url: { url: one.url } });
  }
  /* 只留图不留字：补一句空文本，否则部分服务商把空 content 当坏请求 */
  if (!parts.length) return { content: "" };
  if (!parts.some((p) => p.type === "text")) parts.unshift({ type: "text", text: "" });
  return { content: parts, hasImages: images > 0, images: images };
}
/* 应用侧消息白名单：role 只认 system/user/assistant；content 认字符串与多模态数组 */
function buildMessages(opts) {
  const out = [];
  const quota = { bytes: 0 };
  let images = 0;
  const src = Array.isArray(opts.messages) ? opts.messages.slice(0, MAX_MESSAGES) : [];
  for (const m of src) {
    if (!isObj(m)) continue;
    const role = normRole(m.role);
    if (!role) continue;
    const c = normContent(m.content, quota);
    if (c.error) return { error: c.error };
    if (typeof c.content === "string" ? !c.content.trim() : !c.content.length) continue;
    images += c.images || 0;
    out.push({ role: role, content: c.content });
  }
  if (out.length) return { messages: out, hasImages: images > 0, images: images };
  const system = typeof opts.system === "string" ? opts.system.trim() : "";
  const prompt = typeof opts.prompt === "string" ? opts.prompt : "";
  if (system) out.push({ role: "system", content: system.slice(0, MAX_PROMPT) });
  out.push({ role: "user", content: prompt.slice(0, MAX_PROMPT) });
  return { messages: out, hasImages: false, images: 0 };
}
/* 应用侧思考档白名单（appHost.textGenStream / hostText 的 opts.thinking）：
 *   不传 = off —— 应用通道**默认关思考**。理由不是省 token，而是别把应用要的正文吃掉：
 *   DeepSeek V4 默认开思考，而 max_tokens（应用自己给的上限）是「思考 + 正文」共用的预算，
 *   实测同一请求（deepseek-v4-flash · max_tokens 1200 · 要一段 JSON）开思考时 6 次里 4 次
 *   finish_reason=length —— 正文为空或只出半截 JSON，应用只能报「回复不是可用 JSON」；
 *   关思考后同一请求 108~116 token 就出完整 JSON（回归见 test/smoke-apps.js）。
 *   认 off / on（= high）/ low / high / max；其它值回结构化错误码 bad_thinking，不猜也不静默降级。 */
const APP_THINKING = { off: "off", on: "high", low: "low", high: "high", max: "max" };
function normThinkingEffort(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  if (!s) return "off";
  return APP_THINKING[s] || "";
}
function hostSpec(id, kind, opts) {
  const o = isObj(opts) ? opts : {};
  if (kind === "image") {
    const provider = providerFor("image");
    if (!provider)
      return { error: t("未配置可用的图像服务商（请在「设置 · API/配置」中填写）"), code: "no_provider" };
    return {
      spec: {
        provider: provider,
        kind: "image",
        model: modelIdsOf(provider)[0] || "",
        prompt: String(o.prompt || "").slice(0, MAX_PROMPT),
        size: String(o.size || ""),
        quality: String(o.quality || ""),
        background: String(o.background || ""),
      },
    };
  }
  const built = buildMessages(o);
  if (built.error) return { error: msgErrorText(built.error), code: built.error };
  const hasImages = built.hasImages;
  const fallback = providerFor("text");
  if (!fallback)
    return { error: t("未配置可用的文本服务商（请在「设置 · API/配置」中填写）"), code: "no_provider" };
  const resol = resolveModelFor(id, modelIdsOf(fallback)[0] || "", o.model, hasImages);
  if (resol.error)
    return {
      error: resol.error === "no_vision" ? t(NO_VISION_TEXT) : t(BAD_MODEL_TEXT),
      code: resol.error,
    };
  const provider =
    (resol.providerId && providersFromConfig().find((p) => String(p.id || "") === String(resol.providerId))) ||
    fallback;
  /* 带图必须走在「服务商声明支持视觉」那条路上；否则模型看不见图，等于静默降级 */
  if (hasImages && provider.vision !== true)
    return { error: t(NO_VISION_TEXT), code: "no_vision" };
  /* 思考档：不传 = off（见 normThinkingEffort 头部口径）；非法值当场拒绝 —— 绝不静默按 off 处理，
     否则应用以为自己开了思考，实际没有，只会更难排查 */
  const think = normThinkingEffort(o.thinking);
  if (!think) return { error: t("thinking 只认 off / on / low / high / max"), code: "bad_thinking" };
  const msgs = built.messages.slice();
  const lastUser = (() => {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") return msgs[i];
    return null;
  })();
  const promptOf = (m) => {
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    return m.content
      .filter((p) => p && p.type === "text")
      .map((p) => p.text)
      .join("\n");
  };
  const temp = Number(o.temperature);
  return {
    spec: {
      provider: provider,
      kind: "text",
      model: resol.modelId,
      /* vision = 本次是不是带图请求：内核按 provider.vision 决定下发判据，这一位只作旁证与排查用 */
      vision: hasImages,
      /* 思考档（off / low / high / max）随 spec 下发，由内核 applyTextThinkingEffort 落成
         body.thinking / reasoning_effort —— 默认 off，应用显式传 thinking 才开 */
      effort: think,
      images: [],
      prompt: promptOf(lastUser),
      chatMessages: msgs,
      temperature: Number.isFinite(temp) ? Math.max(0, Math.min(2, temp)) : 0.7,
      /* 输出上限：应用显式给值才下发（不传 = 不限；不给应用设默认上限 —— 上限会把正文截断，
         而应用多半只会把它当成「模型不会用 JSON」）。 */
      maxTokens: Number(o.maxTokens) > 0 ? Math.round(Number(o.maxTokens)) : 0,
    },
  };
}
const NO_VISION_TEXT =
  "本次带图，但当前模型 / 服务商不支持识图：请在该应用的「模型」里选一个带「支持识图」的模型，或在 MTNode「设置 · 模型服务」里配置支持图像的服务商";
const BAD_MODEL_TEXT = "该模型不在 MTNode 已配置的模型清单里（请在应用的「模型」里重新选择）";
/* 结构化错误码 → 给人看的一句话（应用侧可只看 code，文案只是兜底） */
function msgErrorText(code) {
  if (code === "too_many_images") return t("一条消息里的图片太多（上限 8 张）");
  if (code === "too_large") return t("图片总大小超出上限（10MB）");
  return t("图像读不出或格式不支持（支持 png / jpg / webp / gif）");
}
/* 主进程调用结果 → 应用侧回执：正文 + 思考量 + **是否被截断**。
   截断必须让应用看得见：max_tokens 到顶时模型正文是半截的（JSON 当然也解不出来），
   应用据此能说「回复被截断，请给更大上限」，而不是含糊的「回复不是可用 JSON」。 */
function textResult(r, model) {
  const reasoning = String((r && r.reasoning) || "");
  const finishReason = String((r && r.finishReason) || "");
  return {
    ok: true,
    text: String((r && r.text) || ""),
    reasoning: reasoning,
    reasoningChars: reasoning.length,
    finishReason: finishReason,
    truncated: !!(r && r.truncated) || finishReason === "length",
    model: model,
  };
}
async function hostText(e, opts) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const built = hostSpec(own.id, "text", opts);
  if (built.error) return bad(built.error, built.code || "no_provider");
  if (typeof aiCall !== "function") return bad(t("模型调用内核不可用"), "no_kernel");
  try {
    const r = await aiCall(built.spec);
    return textResult(r, built.spec.model || "");
  } catch (err) {
    return fail(err);
  }
}
async function hostTextStream(e, opts) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const built = hostSpec(own.id, "text", opts);
  if (built.error) return bad(built.error, built.code || "no_provider");
  const wc = e.sender;
  const reqId = String((isObj(opts) && opts.reqId) || "");
  const emit = (type, data) => {
    try {
      if (!wc.isDestroyed()) wc.send("apps:hostStream", Object.assign({ reqId: reqId, type: type }, data || {}));
    } catch {}
  };
  const model = String((built.spec && built.spec.model) || "");
  if (typeof aiCallStream !== "function") {
    const r = await hostText(e, opts);
    emit(r.ok ? "done" : "error", r.ok ? { text: r.text, model: model } : { error: r.error, code: r.code || "" });
    return r;
  }
  try {
    const r = await aiCallStream(built.spec, emit);
    return textResult(r, model);
  } catch (err) {
    const msg = String((err && err.message) || err);
    const code = callErrCode(err);
    emit("error", { error: msg, code: code });
    return { ok: false, error: msg, code: code };
  }
}
async function hostImage(e, opts) {
  const own = senderAppDir(e);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const built = hostSpec(own.id, "image", opts);
  if (built.error) return bad(built.error, built.code || "no_provider");
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
  /* 图像缩放内核（main.js 的 shrinkImageBuffer）：应用侧多模态消息与画布节点同一份口径
     （长边 ≤ 1080 等比缩），不在这儿另写一套。 */
  if (typeof opts.shrinkImage === "function") shrinkImage = opts.shrinkImage;
  if (typeof opts.getProviderCatalog === "function") providerCatalog = opts.getProviderCatalog;
  /* 语音转写（appHost.asr*）：dsh 适配器与「本应用数据文件夹」两个来源都由 main.js 注入 ——
     apps-store 不认识 dsh，也不自己拼数据目录（路径只走 appDataDirOf 这一处口径）。 */
  if (typeof opts.getDsh === "function") getDshForSpeech = opts.getDsh;
  getAppDataDirForSpeech = (id) => {
    try {
      return appDataDirOf(String(id || ""));
    } catch {
      return "";
    }
  };

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
  /* 新建应用：{ name 标题, id 文件夹名, style 设计风格 } → 建 <root>/<id>/ + app.json
     （画布由渲染层紧接着走既有 workflow:save 建，见 createApp 头部注释）。 */
  ipcMain.handle("apps:create", guard((e, arg) => createApp(arg)));
  /* 设计风格：清单（含预览图 data URL）+ 换风格（重写应用目录的入口页） */
  ipcMain.handle("apps:styles", guard((e, arg) =>
    appStylesPayload(!isObj(arg) || arg.preview !== false),
  ));
  ipcMain.handle("apps:setStyle", guard((e, arg) => setAppStyle(arg)));
  /* 本机状态字段写入口（渲染层不碰文件系统）：{ id, dev?, author?, forkOf? } ——
     二次开发（dev:true + 作者）、上架成功后写作者与二次开发来源都走这一条。 */
  ipcMain.handle("apps:setMeta", guard((e, arg) => setAppMeta(arg)));
  ipcMain.handle("apps:catalog", async (e, arg) => {
    try {
      const cat = await loadCatalog(arg || {});
      /* 渲染层要能显示图标、版本树也要能显示每一版的下载地址：
         主进程按**来源**把它们解析成可直接请求的 URL（静态 = FEED + 相对路径；
         接口 = <store>/api/apps/<id>/file|icon），渲染层不重复推导、也不硬编码域名。 */
      if (cat && Array.isArray(cat.apps)) {
        for (const spec of cat.apps) {
          try {
            spec.urls = zipUrlsOf(spec);
          } catch {}
        }
      }
      return cat;
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
  /* 上架（§七）：拍应用自己的窗口 + 现打包读回 base64（上架窗只拿回执，不碰文件系统） */
  ipcMain.handle("apps:shotWindow", async (e, arg) => shotAppWindow(isObj(arg) ? arg.id : arg));
  ipcMain.handle("apps:readZipBase64", guard((e, arg) => readPackBase64(isObj(arg) ? arg.id : arg)));
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
  /* 模型继承（列清单 / 读选择 / 改选择）：应用窗口不能在已配置清单之外挑模型，
     服务商与 Key 一律不回传（见 hostModelsPayload 一节）。 */
  ipcMain.handle("apps:hostModels", guard((e) => hostModelsPayload(e)));
  ipcMain.handle("apps:hostModel", guard((e) => hostModelGet(e)));
  ipcMain.handle("apps:hostSetModel", guard((e, arg) => hostModelSet(e, arg)));
  /* 宿主选图（多模态输入里的「选一张本机图」）：只回路径，读盘 / 缩放留在主进程 */
  ipcMain.handle("apps:hostPickImage", async (e) => {
    try {
      const own = senderAppDir(e);
      if (!own) return bad(t("不是应用窗口"), "not_app");
      return await pickImageForApp(BrowserWindow.fromWebContents(e.sender) || getMainWin());
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
  /* ── appHost 语音转写（官方本地 SenseVoice，跑在 dsh 运行时里）──
     选音频 / 转写 / 状态 / 首次下载权重：应用侧只拿到文本与状态，识别与读盘都在主进程。 */
  ipcMain.handle("apps:hostPickAudio", async (e) => {
    try {
      return await pickAudioForApp(e);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:hostAsrTranscribe", async (e, arg) => {
    try {
      return await hostAsrTranscribe(e, arg);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:hostAsrStatus", async (e) => {
    try {
      return await hostAsrStatus(e);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:hostAsrPrepare", async (e, arg) => {
    try {
      return await hostAsrPrepare(e, arg);
    } catch (err) {
      return fail(err);
    }
  });
  /* 应用窗口的麦克风可用性：只回「宿主放没放行 + 是不是应用窗口」，
     真正的 getUserMedia 在应用页里（权限由 main.js 给 app 窗口的会话挂 handler 放行）。 */
  ipcMain.handle("apps:hostAsrMic", guard((e) => {
    const own = senderAppDir(e);
    if (!own) return bad(t("不是应用窗口"), "not_app");
    return { ok: true, mic: true, note: "getUserMedia 在应用页里直接调用（宿主已放行 media 权限）" };
  }));

  /* ── 应用数据（主窗口 / 应用中心侧）：只留「打开数据目录」这一件事 ──
     数据目录用 app id 管理（默认数据根 <数据目录>/apps-data/<id>/，用户改过则是他选的那个），
     入口是库 / 开发页每张卡片右侧那颗 📂；路径只由主进程解析，渲染层不拼路径、不写路径。
     改数据文件夹位置仍只在应用窗口里（preload-app.js 的 appHost.dataDir* → apps:hostDataDir*）。 */
  ipcMain.handle("apps:dataOpen", async (e, arg) => {
    try {
      const id = safeAppId(isObj(arg) ? arg.id : arg);
      if (!id) return bad(t("应用 id 不合法"), "bad_id");
      return await openAppDataDir(id);
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = {
  registerAppsIpc,
  shutdownApps,
  setQuitHandler,
  rootPath,
  setRoot,
  listApps,
  createApp,
  setAppMeta,
  /* 设计风格：清单真源 + 换风格（渲染层只经 IPC 用，smoke 直接断言这两条真源） */
  APP_STYLES,
  APP_STYLE_IDS,
  APP_DEFAULT_STYLE,
  APP_CUSTOM_STYLE,
  normAppStyle,
  normStoredAppStyle,
  appStyleIsCustom,
  appStyleIds,
  appPresetStyleIds,
  setAppStyle,
  appStylesPayload,
  stylePreviewDataUrl,
  defaultPageHtml,
  mirrorAppCanvas,
  loadCatalog,
  installApp,
  uninstallApp,
  exportZip,
  /* 目录双源（静态目录 / 云端接口）：解析与来源判定是纯函数段，冒烟直接真跑 */
  parseCatalogDoc,
  resolveZipUrl,
  zipUrlsOf,
  specBaseOf,
  /* 上架（docs/apps-market.md §七）：拍照 + 现打包（纯函数段，冒烟直接真跑） */
  shotAppWindow,
  readPackBase64,
  normVersionItem,
  normVersionsOf,
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
  /* 应用侧模型继承与多模态消息（冒烟直接真跑纯函数段：应用窗口不存在时也能钉住契约） */
  listTextModels,
  resolveModelFor,
  readModelSelection,
  writeModelSelection,
  buildMessages,
  imagePartUrl,
  decodeImageDataUrl,
  callErrCode,
  MODEL_AUTO,
  MAX_MSG_IMAGES,
  MAX_MSG_IMAGE_BYTES,
  /* 应用通道的思考档白名单（纯函数，冒烟直接真跑：默认 off、on=high、非法值拒绝） */
  normThinkingEffort,
  APP_THINKING,
};

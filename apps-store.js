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
 *                                    + 本机状态：author 作者 / dev 开发中 / forkOf 二次开发来源 /
 *                                      cloud 上架留痕）
 *     index.html                     入口页（zip 里带；缺失时补一份最小脚手架）
 *     assets/** 与任意其它文件        应用自己的文件（**整目录随包**，子目录递归 —— 根目录
 *                                    放 game.js / style.css 这类多文件应用照样能上架；
 *                                    只排除画布 / 旧包 / 安装账本 / .staging，见 packExcludedFiles）
 *     storage/store.json             **该应用自己的本机存储**（appHost.storageGet / storageSet）：
 *                                    本地导出保留，上架包剔除（不把作者存档发给下载者）
 *     <AppName>.mtnodes              该应用的画布（保存画布时写入；导出 zip 与更新安装都不碰它）
 *     <AppName>.zip                  导出的应用包（appHost 目录 = 用户搬家 / 上架用）
 *     installed.json                 本机安装账本（本次装进去的文件清单 / 来源 / sha256 / 来源作者，**不导出**）
 *   <root>/                          .staging/ 为解包中转目录，装完即清
 *
 * 根目录设置（沿用 installDir 口径的键名，**写在本机 config.json，不写应用目录**）：
 *   <数据目录>/config.json → { "apps": { "installDir": "<绝对路径>" } }
 *   兼容读 appInstallDir / appsInstallDir / appsRoot（老写法 / 手改过的配置）；
 *   **不再要求用户手动指定**（本轮口径）：没人配过时直接用默认根 <数据目录>/apps（下载）与
 *   <数据目录>/apps-dev（开发）—— 也就是画布所在的那个数据文件夹，不弹选目录框、不打「未设置」；
 *   真正要用到根时（列应用 / 下载 / 新建）由 ensureRootPersisted 把默认路径固化进 config.json。
 *   默认落在 %APPDATA%，绝不落应用目录。
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
 *   apps:setMeta（本机状态字段 dev / author / forkOf / cloud 的唯一写入口，渲染层不碰文件系统）
 *   apps:probeChanges · apps:openWindow / closeWindow / isOpen
 *   apps:shotWindow · apps:readZipBase64（上架窗用：拍应用自己的窗口 + **一趟**现打包读回 base64，
 *   契约见 docs/apps-market.md §七；渲染层不碰文件系统与网络）
 *   （apps:exportZip 已随「上架只打一趟包」下线：上架窗改用 apps:readZipBase64 一次拿到
 *     base64 + sha256，见 exportZip 段与 readPackBase64 的注释）
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
/* 应用能力清单（app.json 的 capabilities）：纯计算模块，见文件头 */
const {
  normCapabilities,
  capabilityOn,
  capabilitiesForUi,
  capabilityBadges,
} = require("./apps-capabilities.js");
/* 模型形态识别（config.modelKinds 手工覆盖 + 图像模型家族特征词）：与渲染层的设置页、
   画布节点共用同一份纯函数段 —— 应用侧的「可用图像后端」不再只看服务商 type 是否 image_*，
   否则把图像模型挂在 text_openai 卡上（本机最常见的一种配法）时应用永远出不了图。 */
const { providerHasKind, modelKindOf, providerForRequest } = require("./renderer/app-model-kind.js");
/* 应用版本合并（对方那一版 → 我本机开发中的那一支）：纯逻辑 + 依赖注入，见 app-branch-merge.js 的
   文件头（口径、范围、产物都在那儿）。依赖在文件后段注入（那些实现都定义在后面）。 */
const { createBranchMerge } = require("./app-branch-merge.js");
/* 应用版本「完全替换」（对方那一版 → 整份接替本机的开发分支，不经过 Agent）：同样纯逻辑 +
   依赖注入，见 app-branch-replace.js 的文件头。画布层的四个动作由 main.js 注入。 */
const { createBranchReplace } = require("./app-branch-replace.js");

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
/* 类型 → 那棵数据根的子目录名（见 apps-data/<dev|downloaded>/<id>） */
const DATA_SUB = { dev: "dev", down: "downloaded" };
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
const PREVIEW_K = "__mtnodePreview";
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

/* ── 预览页的宿主桥小助手（本轮需求：预览状态下也能连入 MTNode）──────────────────
 *
 * 预览页是**一只 iframe**，没有 preload，所以 window.appHost 本来是 undefined，应用只能退回
 * localStorage。这一段在页面**最前面**跑，拼出与 preload-app.js **同形状**的 window.appHost：
 *   · 每个能力都是薄壳：调用 → postMessage 给开发页（父窗口）→ 开发页按来源帧校验后调
 *     主窗口 preload 的 apps:previewHost* 通道 → 主进程按「预览租约」认应用 →
 *     走**与独立窗口逐字同一条**宿主实现；
 *   · 同步判据（cap / hostName / id / readOnly）是本地布尔量，所以应用里
 *     `if (AppHost.cap.host)`、`AppHost.cap.text` 这类写法照常成立；
 *   · 只读（应用已被开在独立窗口里）时，写类能力**同步拒**（回 readonly_preview），
 *     不让应用白等一趟往返；
 *   · localStorage / sessionStorage 在「宿主可用 + 只读」时换成内存态：
 *     应用照旧读写不报错，但绝不悄悄写进浏览器存档（换窗口 / 清缓存会丢的那种）。
 *
 * 与页面里既有的 AppHost 门面（templates/app-scaffold/apphost.js）的关系：
 * 本文件必须**先跑**（它是 inline 脚本里最靠前的一段），门面再读到的就是这座桥，
 * 于是「预览里也有宿主」这件事对应用是透明的：三件基础设施（落盘 / 数据文件夹 / 正确关闭）
 * 一处都不用改。 */
const PREVIEW_BRIDGE = [
  "(function(){",
  "if (window.__mtnodePreviewHost) return;",
  "if (window.parent === window) return; /* 不在 iframe 里：不是预览 */",
  "var K='" + PREVIEW_K + "';",
  "var seq=0; var pending={}; var streams=[];",
  /* 写类能力（只读时同步拒）：与主进程 previewWriteBlock 的那一份清单同源 */
  "var WRITE={dataWrite:1,storageSet:1,storageRemove:1,hostSetModel:1,hostImageSetModel:1,image:1,imageEdit:1,dataDirPick:1,dataDirReset:1};",
  "function mkErr(o){ var e=new Error(String((o&&o.error)||'preview bridge error')); e.code=String((o&&o.code)||''); if(o&&o.previewReadOnly) e.previewReadOnly=true; return e; }",
  "function post(msg){ try{ window.parent.postMessage(msg,'*'); }catch(e){} }",
  "var CALL_MS=20000; /* 中继没了（切走 / 关页 / 宿主重绘）时别让应用的 await 永远挂着 */",
  "function call(method,arg){",
  "  if (state.readOnly && WRITE[method]) return Promise.reject(mkErr({code:'readonly_preview',error:'该应用已在独立窗口运行，预览为只读',previewReadOnly:true}));",
  "  return new Promise(function(res,rej){",
  "    var id='c'+(++seq).toString(36)+Math.random().toString(36).slice(2,7);",
  "    var timer=setTimeout(function(){ if(!pending[id]) return; delete pending[id]; rej(mkErr({code:'host_unreachable',error:'预览宿主没有回应（中继已断开或这一帧已失效）'})); },CALL_MS);",
  "    pending[id]={res:res,rej:rej,at:Date.now(),timer:timer};",
  "    post({[K]:1,op:'host-call',id:id,method:String(method||''),arg:(arg===undefined?null:arg)});",
  "  });",
  "}",
  /* 流式订阅：cb 收 delta / progress / done / error（与独立窗口的 cb 同一形状）。
     事件按 reqId 分流：同一个预览页里可能同时开着文本流与出图。 */
  "function stream(method,arg,cb){",
  "  var o=arg||{}; var reqId=String(o.reqId||('r'+(++seq).toString(36)+Math.random().toString(36).slice(2,7)));",
  "  o.reqId=reqId;",
  "  var handler=null;",
  "  if (typeof cb==='function'){",
  "    handler=function(msg){ if(String(msg.reqId||'')!==reqId) return; try{ cb(msg); }catch(e){} };",
  "    streams.push(handler);",
  "  }",
  "  var p=call(method,o);",
  "  var drop=function(){ if(!handler) return; var i=streams.indexOf(handler); if(i>=0) streams.splice(i,1); };",
  "  p.then(drop,drop);",
  "  return p;",
  "}",
  "var state={id:'',readOnly:false,ready:false};",
  "function applyReady(d){ state.id=String((d&&d.appId)||''); state.readOnly=!!(d&&d.readOnly); state.ready=true; var o={appId:state.id,readOnly:state.readOnly}; window.__mtnodePreviewHost=o; try{ window.dispatchEvent(new CustomEvent('mtnode-preview-host',{detail:o})); }catch(e){} applyStorage(); }",
  "window.addEventListener('message',function(ev){",
  "  var d=ev&&ev.data; if(!d||d[K]!==1) return;",
  "  if(d.op==='host-ready'){ applyReady(d); return; }",
  "  if(d.op==='host-state'){ state.readOnly=!!d.readOnly; if(window.__mtnodePreviewHost) window.__mtnodePreviewHost.readOnly=state.readOnly; applyStorage(); return; }",
  "  if(d.op==='host-result'){ var p=pending[d.id]; if(!p) return; delete pending[d.id]; if(p.timer) clearTimeout(p.timer); if(d.ok) p.res(d.result); else p.rej(mkErr(d.result||{})); return; }",
  "  if(d.op==='host-event'){ var msg=d.event||{}; for(var i=0;i<streams.length;i++){ try{ streams[i](msg); }catch(e){} } try{ window.dispatchEvent(new CustomEvent('mtnode-preview-event',{detail:msg})); }catch(e){} return; }",
  "  if(d.op==='host-notice'){ try{ window.dispatchEvent(new CustomEvent('mtnode-preview-notice',{detail:d.notice||{}})); }catch(e){} return; }",
  "});",
  /* 这一帧要走了（换页 / 关页）：把在飞的调用立刻作废，别让应用白等到超时 */
  "try{ window.addEventListener('pagehide',function(){ for(var k in pending){ var p=pending[k]; if(!p) continue; if(p.timer) clearTimeout(p.timer); p.rej(mkErr({code:'host_unreachable',error:'预览宿主已断开'})); } pending={}; },{once:true}); }catch(e){}",
  /* 只读时的 localStorage 兜底：内存态（真窗口里绝不会有这一段 —— 那段只在预览注入） */
  "function memStore(){ var m={}; return {getItem:function(k){ k=String(k); return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null; }, setItem:function(k,v){ m[String(k)]=String(v); }, removeItem:function(k){ delete m[String(k)]; }, clear:function(){ m={}; }, key:function(i){ var ks=Object.keys(m); return i<ks.length?ks[i]:null; }, get length(){ return Object.keys(m).length; }}; }",
  "function applyReady(d){ state.id=String((d&&d.appId)||''); state.readOnly=!!(d&&d.readOnly); state.ready=true; var o={appId:state.id,readOnly:state.readOnly}; window.__mtnodePreviewHost=o; try{ window.dispatchEvent(new CustomEvent('mtnode-preview-host',{detail:o})); }catch(e){} applyStorage(); }",
  "var memL=memStore(), memS=memStore();",
  "function applyStorage(){",
  "  try{ window.__mtnodePreviewReadOnly=!!state.readOnly; }catch(e){}",
  "  if(!state.readOnly) return;",
  "  try{ Object.defineProperty(window,'localStorage',{configurable:true,get:function(){ return memL; }}); }catch(e){}",
  "  try{ Object.defineProperty(window,'sessionStorage',{configurable:true,get:function(){ return memS; }}); }catch(e){}",
  "}",
  /* ── window.appHost：与 preload-app.js 同形状的薄壳 ── */
  "var api={",
  "  textGenStream:function(opts,cb){ return stream('textGenStream',opts,cb); },",
  "  imageGen:function(opts,cb){ return stream('imageGen',opts,cb); },",
  "  imageEdit:function(opts,cb){ return stream('imageEdit',opts,cb); },",
  "  imageGenCancel:function(reqId){ return call('imageGenCancel',{reqId:String(reqId||'')}); },",
  "  hostImageModels:function(){ return call('hostImageModels'); },",
  "  hostImageModel:function(){ return call('hostImageModel'); },",
  "  hostImageSetModel:function(model){ return call('hostImageSetModel',{model:model}); },",
  "  hostModels:function(){ return call('hostModels'); },",
  "  hostModel:function(){ return call('hostModel'); },",
  "  hostSetModel:function(model){ return call('hostSetModel',{model:model}); },",
  "  pickImage:function(){ return call('pickImage'); },",
  "  pickAudio:function(){ return call('pickAudio'); },",
  "  transcribe:function(opts){ return call('transcribe',opts||{}); },",
  "  transcribeWav:function(b64,opts){ var o={}; for(var k in (opts||{})) o[k]=opts[k]; o.base64=String(b64||''); return call('transcribe',o); },",
  "  asrStatus:function(){ return call('asrStatus'); },",
  "  asrPrepare:function(opts){ return call('asrPrepare',opts||{}); },",
  "  asrMic:function(){ return call('asrMic'); },",
  "  onSpeechState:function(cb){",
  "    if(typeof cb!=='function') return function(){};",
  "    var fn=function(ev){ var d=ev&&ev.detail; if(d&&d.type==='speech-state'){ try{ cb(d.data||{}); }catch(e){} } };",
  "    try{ window.addEventListener('mtnode-preview-event',fn); }catch(e){}",
  "    return function(){ try{ window.removeEventListener('mtnode-preview-event',fn); }catch(e){} };",
  "  },",
  "  storageGet:function(key){ return call('storageGet',{key:key}); },",
  "  storageSet:function(key,value){ return call('storageSet',{key:key,value:value}); },",
  "  storageAll:function(){ return call('storageAll'); },",
  "  storageRemove:function(key){ return call('storageRemove',{key:key}); },",
  "  dataDirGet:function(){ return call('dataDirGet'); },",
  "  dataDirPick:function(){ return call('dataDirPick',{q:true}); },",
  "  dataDirOpen:function(){ return call('dataDirOpen'); },",
  "  dataDirReset:function(){ return call('dataDirReset'); },",
  "  dataRead:function(opts){ return call('dataRead',opts||{}); },",
  "  dataWrite:function(data,opts){ var o={}; for(var k in (opts||{})) o[k]=opts[k]; o.data=data; return call('dataWrite',o); },",
  "  account:function(){ return call('account'); },",
  /* close / quit：预览里没有「自己的窗口」——同步回可读错误码，并请开发页在预览区浮一条提示 */
  "  close:function(){ post({[K]:1,op:'host-notice',notice:{code:'preview_no_window'}}); return Promise.reject(mkErr({code:'preview_no_window',preview:true,error:'预览里没有可关闭的独立窗口（预览是开发页中栏的一只 iframe）'})); },",
  "  quit:function(){ post({[K]:1,op:'host-notice',notice:{code:'preview_no_window'}}); return Promise.reject(mkErr({code:'preview_no_window',preview:true,error:'预览里没有可退出的独立窗口（预览是开发页中栏的一只 iframe）'})); },",
  /* 关窗收尾钩子：预览里没有关窗动作可钩，登记即空转（不假装能收尾） */
  "  onWillClose:function(){ return function(){}; }",
  "};",
  "function shapecap(cap){",
  "  var out={};",
  "  for(var k in cap){ out[k]=cap[k]; }",
  "  return out;",
  "}",
  "function readonlycap(cap){",
  "  var out=shapecap(cap);",
  "  out.host=(window.parent!==window);",
  "  if(!state.readOnly) return out;",
  "  var W={data:1,storage:1,dataDir:1,dataDirPick:1,dataDirReset:1,image:1,imageModels:1,models:1};",
  "  for(var k in W){ if(out[k]) out[k]=false; }",
  "  return out;",
  "}",
  "var CAP={host:true,hostName:'preview',id:false,close:false,quit:false,data:true,dataDir:true,dataDirPick:true,dataDirOpen:true,dataDirReset:true,willClose:false,storage:true,account:true,net:false,image:true,imageModels:true,imageCancel:true,text:true,json:true,models:true,pick:true,shown:false,speech:true,speechFile:true,speechStatus:true,speechPrepare:true,speechEvents:true};",
  "try{ Object.defineProperty(window,'__mtnodePreviewHostCap',{configurable:true,get:function(){ return readonlycap(CAP); }}); }catch(e){}",
  "try{",
  "  window.appHost=api;",
  "  /* 门面（templates/app-scaffold/apphost.js）读的是 dataRead/dataWrite 这些老名字：",
  "     这里补一层等价别名，让老写法在预览里也照常命中（没列的键仍然是 undefined）。 */",
  "  api.dataGet=api.dataRead; api.dataSet=api.dataWrite;",
  "}catch(e){}",
  /* 桥就绪：等开发页回 host-ready（拿到 appId 与只读态）后再广播给应用侧
     （app-speech-ui.js 的听写条就是靠 'mtnode-apphost' 这一条自挂的） */
  "function announce(){",
  "  try{ window.dispatchEvent(new CustomEvent('mtnode-apphost',{detail:{host:api}})); }catch(e){}",
  "}",
  "function boot(){",
  "  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){ setTimeout(announce,0); },{once:true});",
  "  else setTimeout(announce,0);",
  "}",
  "post({[K]:1,op:'host-ping'});",
  "boot();",
  "})();",
].join("\n");

/* 注入宿主桥小助手：**必须插在页面最前面**（在其他 <script> 之前），
   这样应用里的 window.AppHost 门面一跑就读到这座桥。 */
function injectPreviewBridge(html) {
  const src = String(html || "");
  const tag =
    '<script data-mtnode-preview-bridge="1">' + PREVIEW_BRIDGE + "</scr" + "ipt>";
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (m) => m + tag);
  return tag + src;
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
   HTML 一律注入页面状态小助手（刷新预览的「维持状态」靠它）。
   带 _host=1 的那条路（开发页中栏那只 iframe）**额外**在最前面注入宿主桥小助手
   （PREVIEW_BRIDGE）：预览里也就有了 window.appHost。别的入口（直接开这个 url、
   上架前的静态预览截图之类）不带这个参数 → 逐字还是老的纯静态预览。 */
function previewFileResponse(dir, rel, req, injectHost) {
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
      if (injectHost) html = injectPreviewBridge(html);
      return new Response(injectPreviewAgent(html), { headers: headers });
    }
    return new Response(fs.readFileSync(abs), { headers: headers });
  }
  return null;
}
/* 这次预览请求要不要注入宿主桥：开发页的 iframe url 带 _host=1。
   不带 = 直接开 url / 静态预览：逐字还是老的纯静态预览（不假装有宿主）。 */
function previewWantsHost(u) {
  try {
    return String(u.searchParams.get("_host") || "") === "1";
  } catch {
    return false;
  }
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
      /* 带 _host=1 = 开发页中栏那只 iframe（见 previewWantsHost）：**开发页预览的永远是项目根
         那一份**（用户在改的就是它）—— 同 id 在下载根也有一份时，按 id 猜会预览到下载副本。 */
      const withHost = previewWantsHost(u);
      /* URL 的 host 会被规范成小写，所以按大小写不敏感找目录 */
      const dir = previewDirOf(
        decodeURIComponent(String(u.hostname || "")),
        withHost ? APP_KIND_DEV : "",
      );
      if (!dir) return plain(t("应用目录不存在"), 404);
      const rel = decodeURIComponent(String(u.pathname || "")).replace(/^\/+/, "");
      /* 一次读文件：请求的那一页不在时，按 app.json 入口页 → 默认 index.html 兜底，
         预览始终落到应用的默认界面（详细口径见 previewFileResponse） */
      const hit = previewFileResponse(dir, rel, req, withHost);
      if (hit) return hit;
      /* 兜底链走完都没有：导航请求回「入口页 + 一条可读提示」，资源请求照常 404 */
      const man = manifestOf(dir, path.basename(dir));
      const entry = safeEntry(man && man.entry) || SUB.index;
      if (previewWantsHtml(req)) {
        const abs = resolveInside(dir, entry);
        if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          let html = previewFallbackHtml(
            fs.readFileSync(abs, "utf8"),
            rel && rel !== entry ? rel : "",
            entry,
          );
          if (withHost) html = injectPreviewBridge(html);
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
/* 本机图像后端（SenseNova）宿主适配器：由 main.js 注入，apps-store 不认识它的内部结构 ——
   与语音（getDshForSpeech）同一条纪律。四项都是「能不给就不给」的可选注入。 */
let localImageHost = null;
let localImageGenerate = null;
let localImageCancel = null;
let localImageSnapshot = null;
/* 全局音视频互斥锁快照（main.js 注入 media-gen-global-lock 的 refreshStaleLock） */
let readMediaLock = null;
/* 在飞的图像请求（reqId → { appId, nodeId, abort }）：取消与进度都按它定位 */
const imageReqs = new Map();
/* 图像缩放内核：registerAppsIpc 注入（main.js 的 shrinkImageBuffer），默认原样返回 */
let shrinkImage = (buf, ext) => ({ buf: buf, ext: ext });
/* 模型目录（main.js 注入 dsh().providerCatalog）：用来判某个模型是否「支持识图」 */
let providerCatalog = null;
/* 应用侧展示语言（config.json 的 locale）：卡片小标与能力对话框的文案按它选 */
let hostLocale = null;

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

/* ---------------- 根目录（config.json 的 apps.installDir / apps.projectDir） ----------------
 *
 * **两套根，互不重叠**（用户口径：下载的应用与开发的应用严格分开，删一个不能误删另一个）：
 *   · 下载根（kind="down"）：云端目录下来的应用，配置键沿用老名字 `apps.installDir`
 *     （老配置一个字都不用改），默认 <数据目录>/apps。
 *   · 项目根（kind="dev"）：自己开发 / 二次开发的应用（app.json 里 dev:true），
 *     配置键 `apps.projectDir`，默认 <数据目录>/apps-dev。
 * 「这个应用算哪一类」只由 app.json 的 dev 标记决定（见 kindOfManifest），根目录也按类型取：
 * rootPathOf(kind) / appDirOf(kind, id) / appDataRootPath(id)。
 *
 * **不再要求用户手动指定（本轮口径）**：默认根就在**画布所在的数据目录**下，没人配过时
 * 直接用默认，不再弹系统选目录框、不再打「未设置」。真正要用到这个根时由 ensureRootPersisted
 * 把默认路径固化进 config.json（见它那段注释）；已手选的根一律保留。
 * 旧布局搬家见 migrateAppsLayout()（显式入口，绝不自动搬）。 */

const configPath = () => path.join(String(getDataDir() || ""), "config.json");
const cacheDir = () => mk(path.join(String(getDataDir() || ""), "apps-cache"));

/* 应用类型：down = 下载的（云端目录 / 安装账本），dev = 开发的（app.json 的 dev:true） */
const APP_KIND_DOWN = "down";
const APP_KIND_DEV = "dev";
const APP_KINDS = [APP_KIND_DOWN, APP_KIND_DEV];
/* 类型 → 配置键。**installDir 是下载根的老键名**（老配置照旧认，不改键名） */
const KIND_CFG_KEY = { down: "installDir", dev: "projectDir" };
function kindOfRoot(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === APP_KIND_DEV ? APP_KIND_DEV : APP_KIND_DOWN;
}
function kindLabel(kind) {
  return kindOfRoot(kind) === APP_KIND_DEV
    ? t("项目根目录（开发中的应用）")
    : t("下载根目录（从应用中心下载的）");
}
/* 默认根：下载 <数据目录>/apps、开发 <数据目录>/apps-dev（都落在数据目录，绝不落应用目录） */
function defaultRoot(kind) {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("应用宿主未初始化（缺少数据目录）"));
  return path.join(d, kindOfRoot(kind) === APP_KIND_DEV ? "apps-dev" : "apps");
}
/* 老写法（手改过配置 / 迁移中途）：下载根的老键名们，按老顺序认 */
const LEGACY_DOWN_ROOT_KEYS = ["appsInstallDir", "appInstallDir", "appsRoot"];
/* 只读：某一类应用的根目录（没配就回**默认根**，见 defaultRoot）。
   **dev 根没配时不再回落下载根**（用户口径：老写法在项目根未配置时把开发的应用当成躺在
   下载根里，本意是兼容升级，实际制造了一个隐蔽的坑 —— 项目根一旦丢配置（历史上渲染层整份
   回写 config 会抹掉主进程写的 apps.projectDir，见 main.js 的 mergeConfigForSave），界面上
   什么都看不出来，只是「开发中的应用」整列消失、预览报「该应用不在本机」）。
   现在：没配 = 用**默认根**（<数据目录>/apps-dev），不再回退下载根，也**不再要求用户手选**；
   真正要用到根的地方（list / install / create）走 ensureRootPersisted 把默认路径固化下来。
   注意：下载根的老键名（appsInstallDir / appInstallDir / appsRoot）仍然认 —— 那是**同一个
   根的旧键名**，不是跨目录回落，删了才会让老配置丢下载根。 */
function rootPathOf(kind) {
  const k = kindOfRoot(kind);
  const cfg = readJson(configPath(), {}) || {};
  const apps = isObj(cfg.apps) ? cfg.apps : {};
  const pick = (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s && path.isAbsolute(s) ? path.resolve(s) : "";
  };
  const own = pick(apps[KIND_CFG_KEY[k]]);
  if (own) return { root: own, configured: true, kind: k, fallback: false };
  if (k === APP_KIND_DOWN) {
    for (const key of LEGACY_DOWN_ROOT_KEYS) {
      const abs = pick(cfg[key]);
      if (abs) return { root: abs, configured: true, kind: k, fallback: false, legacyKey: key };
    }
  }
  return { root: defaultRoot(k), configured: false, kind: k, fallback: false };
}
/* 兼容别名：老调用点（下载 / 安装 / 列表）逐字走下载根 */
function rootPath() {
  return rootPathOf(APP_KIND_DOWN);
}
/* ── 默认根的固化（本轮需求：不再要求用户手动指定文件夹） ─────────────────────
 *
 * 用户口径：不再让用户手选文件夹 —— 默认就用**画布所在的数据目录**（画布存档
 * <数据目录>/save/<id>.json，config.json / 会话 / 素材也都在那儿）下的三个子目录：
 *   apps（下载根）/ apps-dev（项目根）/ apps-data（应用数据，见 appDataRootPath）。
 * 其中应用数据本来就不需要手选（默认就在数据目录下），只有两套根以前会拦人。
 *
 * **什么时候写进 config.json**（用户口径「首次真正要用到它时」）：只有下面三处会调它 ——
 *   · listApps（库页 / 开发页「列本机应用」）
 *   · installApp（下载 / 更新 / 回滚）
 *   · createApp（新建应用）
 * 不用到就不写，config.json 保持干净；光启动应用不改用户的配置。
 *
 * 已经手选过的根一律保留（own 键在就直接返回，绝不覆盖）——老机器行为一个字都不变。
 * 写盘失败（目录只读 / 配置被占）**照样把默认根当可用**返回：本轮口径是「不再拦人」，
 * 没固化成配置只是下次再试一次，绝不能因此让用户又回到「先选个文件夹」。
 * 返回与 rootPathOf 同形，另带 persisted（本次是否真写了盘）/ writeFailed。 */
function ensureRootPersisted(kind) {
  const k = kindOfRoot(kind);
  const cur = rootPathOf(k);
  /* 已配过（手选的 / 已固化过的 / 老键名）：原样返回，一个字都不写盘 */
  if (cur.configured) return Object.assign({}, cur, { persisted: false, writeFailed: false });
  const def = String(cur.root || "");
  let persisted = false;
  try {
    /* 默认根永远在数据目录下（defaultRoot），落进应用目录只可能是数据目录本身被手改坏了 ——
       那种情况不写盘，只把默认根当可用（与 checkRoot 同一条守卫口径）。 */
    if (def && !isInsideAppDir(def)) {
      mk(def);
      const cfg = readJson(configPath(), {}) || {};
      const apps = isObj(cfg.apps) ? Object.assign({}, cfg.apps) : {};
      apps[KIND_CFG_KEY[k]] = def;
      writeJson(configPath(), Object.assign({}, cfg, { apps: apps }));
      persisted = true;
    }
  } catch (_) {
    persisted = false;
  }
  return {
    root: def,
    configured: persisted,
    kind: k,
    fallback: false,
    persisted: persisted,
    writeFailed: !persisted,
  };
}
/* 两套根的只读快照（渲染层一次拿到两个根：库页页脚两行、设置里两条） */
function rootsInfo() {
  const out = {};
  for (const k of APP_KINDS) {
    const r = rootPathOf(k);
    out[k] = {
      ok: true,
      kind: k,
      label: kindLabel(k),
      path: r.root,
      configured: !!r.configured,
      fallback: !!r.fallback,
      legacyKey: r.legacyKey || "",
      exists: fs.existsSync(r.root),
      defaultPath: (() => {
        try {
          return defaultRoot(k);
        } catch {
          return "";
        }
      })(),
    };
  }
  return out;
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
function setRoot(p, kind) {
  const k = kindOfRoot(kind);
  const c = checkRoot(p);
  if (!c.ok) return c;
  const before = (() => {
    try {
      const r = rootPathOf(k);
      return r.configured ? r.root : "";
    } catch {
      return "";
    }
  })();
  mk(c.path);
  const cfg = readJson(configPath(), {}) || {};
  const apps = isObj(cfg.apps) ? Object.assign({}, cfg.apps) : {};
  apps[KIND_CFG_KEY[k]] = c.path; /* 按类型写键：installDir（下载）/ projectDir（开发），写在 config.json */
  writeJson(configPath(), Object.assign({}, cfg, { apps: apps }));
  return {
    ok: true,
    kind: k,
    path: c.path,
    previous: before,
    changed: !!before && path.resolve(before) !== c.path,
    exists: fs.existsSync(c.path),
    defaultPath: (() => {
      try {
        return defaultRoot(k);
      } catch {
        return "";
      }
    })(),
    roots: rootsInfo(),
  };
}
async function pickRoot(kind) {
  const k = kindOfRoot(kind);
  const cur = (() => {
    try {
      return rootPathOf(k).root;
    } catch {
      return "";
    }
  })();
  const parent = getMainWin && getMainWin();
  const opts = {
    title: t("选择") + kindLabel(k),
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cur || undefined,
  };
  const r = parent && !parent.isDestroyed()
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  return setRoot(r.filePaths[0], k);
}

/* ---------------- 应用目录结构 ---------------- */

function appDirOf(root, id) {
  const sid = safeAppId(id);
  if (!sid) return "";
  const dir = path.resolve(path.join(root, sid));
  if (path.dirname(dir) !== path.resolve(root)) return "";
  return dir;
}
/* ── 应用类型（down = 下载的 / dev = 开发的）：**只认 app.json 的 dev 标记** ─────────
 * 为什么是 app.json 而不是安装账本：用户口径是「我开发的应用 / 我下载的应用」，
 * 而 dev:true 正是新建应用与「二次开发」写下的那一位（库页 / 开发页也按它分栏）。
 * 安装账本只用来给「没写过 dev 的老应用」兜底分类：有 installed.json = 从云端下来的。 */
function rawManifestOf(dir) {
  try {
    return dir ? readJson(manifestPath(dir), null) : null;
  } catch (_) {
    return null;
  }
}
function kindOfManifest(raw, dir) {
  const j = isObj(raw) ? raw : {};
  if (j.dev === true) return APP_KIND_DEV;
  if (j.dev === false) return APP_KIND_DOWN;
  /* 没写过 dev：有安装账本（installed.json）= 从云端下载的，否则算本机开发的
     （与 devBackfillOnce 同口径） */
  try {
    if (dir && fs.existsSync(installedPath(dir))) return APP_KIND_DOWN;
  } catch (_) {}
  return APP_KIND_DEV;
}
/* 该 id 在本机算哪一类（两套根都看一眼；都不在 = 下载那一类，调用方多半会报 missing）。
   kind 给了就**只看那一套根**（开发页那几条通道要的就是项目根那一份，见 dirOfApp）。
   **两边各有一份时算「下载的」**（清单里那份 dev:true 是上架包两边共用的字段，不能当判据 ——
   否则缺省口径会飘到项目根那份上，库页 / 台账 / 安装那条链全跟着乱）。 */
function diskKindOf(id, kind) {
  const sid = safeAppId(id);
  if (!sid) return kind ? kindOfRoot(kind) : APP_KIND_DOWN;
  const order = kind ? [kindOfRoot(kind)] : APP_KINDS;
  let first = "";
  for (const k of order) {
    let dir = "";
    try {
      dir = appDirOf(rootPathOf(k).root, sid);
    } catch (_) {
      dir = "";
    }
    if (!dir || !fs.existsSync(dir)) continue;
    /* 两套根分开时，**先扫到的那一套根说了算**（下载根优先 = 与 listApps 的排序、渲染层
       「取第一条」同口径）：清单里那份 dev:true 是上架包两边共用的字段，只看它会让缺省口径
       飘到项目根那份上（库页 / 台账 / 安装那条链跟着乱）。kind 显式给了时 order 只有一项，
       自然就是那一套根说了算。 */
    first = k;
    break;
  }
  if (!first) return kind ? kindOfRoot(kind) : APP_KIND_DOWN;
  return first;
}
/* 该应用在某一类根下的目录（不给类型就按本机实际所在的那一边取） */
function dirOfKind(kind, id) {
  try {
    return appDirOf(rootPathOf(kindOfRoot(kind)).root, id);
  } catch (_) {
    return "";
  }
}
/* 该应用在本机的目录：**先按类型取（新布局两边各一份），取不到再两套根都找一遍** ——
   老布局 / 手放进来的应用（文件与类型不一致）也要能打开，绝不因为「哪一边」猜错就打不开。
   两处都没有时回「按类型算出的那一个」（调用方多半会如实报 missing）。
   **kind 给了就只看那一套根**（缺省 = 两套根都看，逐字不变）：同一个 id 在两边各有一份时，
   缺省会先拿下载根那一份 —— 开发页（项目根那份才是用户在改的）必须显式传 dev，
   否则「打开 / 预览 / 数据目录 / 台账」全指到下载副本上。 */
function dirOfApp(id, kind) {
  const sid = safeAppId(id);
  if (!sid) return "";
  if (kind) {
    const k = kindOfRoot(kind);
    const d = dirOfKind(k, sid);
    return d && fs.existsSync(d) ? d : d || "";
  }
  const byKind = dirOfKind(diskKindOf(sid), sid);
  if (byKind && fs.existsSync(byKind)) return byKind;
  for (const k of APP_KINDS) {
    const d = dirOfKind(k, sid);
    if (d && fs.existsSync(d)) return d;
  }
  return byKind;
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
  /* 源作者显示名（昵称；老条目 / 本机 app.json 里没有 = 空串，渲染层退账号名） */
  const ownerName = String(v.ownerName == null ? "" : v.ownerName).trim();
  if (!id) return null;
  return { id: id, ownerId: ownerId, owner: owner, ownerName: ownerName };
}
/* fork 身份键：源 id + 源作者 uid（同一源应用的不同分支靠它归组；uid 缺失时退回 username，
   绝不让一条老数据把整个归组算成「同一个源」）。 */
function forkKeyOf(f) {
  const x = normForkOf(f);
  if (!x) return "";
  return x.id + "|" + (x.ownerId || x.owner || "");
}
/* ── 上架留痕（本机状态字段，本轮需求）──────────────────────────────────────
 * 应用上架成功之后，把「云端 id / 上架账号 / 时间 / 版本」写进 app.json 的 cloud 字段：
 * 上架窗据此在离线时也知道这次是对着同一条提交，并定下次开窗的默认锁定 id。
 * 判定一律用 ownerId（uid）比对当前登录账号，与 forkOf 同一口径：uid 是身份，username 只作显示。
 * 为什么写在 app.json：与 author / forkOf 同一先例（它们就是本机状态字段、随包走）；
 * 下载者拿到这一份也不会被误判成「我上架的」—— 渲染层还要比账号（见 renderer/app-apps.js 的
 * appsPublishTraceOf）。
 * 空 / 非法一律当「没有留痕」，绝不因此让条目读不出来。 */
function normCloudPub(v) {
  if (!isObj(v)) return null;
  const id = safeAppId(v.id);
  if (!id) return null;
  return {
    id: id,
    ownerId: String(v.ownerId == null ? "" : v.ownerId).trim(),
    owner: String(v.owner == null ? "" : v.owner).trim(),
    version: String(v.version == null ? "" : v.version).trim(),
    at: Number(v.at) || 0,
  };
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
/* 默认数据根：<数据目录>/apps-data/<dev|downloaded>/<id>/ —— **按类型分两棵**，
   下载的与开发的各自一棵，删一棵绝不碰另一棵（数据目录未就绪时抛错，由 guard 变成一句失败）。
   kind 省略 = 按该应用在本机实际所在的那一边（diskKindOf）。 */
function appDataRootPath(id, kind) {
  const sid = safeAppId(id);
  const d = String(getDataDir() || "").trim();
  if (!sid) throw new Error(t("应用 id 不合法"));
  if (!d) throw new Error(t("应用宿主未初始化（缺少数据目录）"));
  const k = kind ? kindOfRoot(kind) : diskKindOf(sid);
  return path.join(d, DATA_ROOT_DIR, DATA_SUB[k], sid);
}
/* 兼容别名（老调用点）：默认那一棵 = 按类型算出来的那一棵 */
function appDataRoot(id) {
  return appDataRootPath(id, "");
}
/* 老结构（升级前）：<数据目录>/apps-data/<id>/ —— 只用于「读回落 + 显式迁移」，绝不往这里写新数据 */
function legacyDataRoot(id) {
  const sid = safeAppId(id);
  const d = String(getDataDir() || "").trim();
  if (!sid || !d) return "";
  return path.join(d, DATA_ROOT_DIR, sid);
}
/* 数据文件夹指针：<那棵数据根>/dataDir.json
 *   { dir, relative, updatedAt } —— 用户选在默认数据根里面时记相对名（换机器 / 换数据目录仍认），
 *   选在外面时记绝对路径（只在本进程内有效，绝不因此把应用目录当数据目录用）。
 *   读的时候新位置优先、**老位置（apps-data/<id>/）回落**：升级后老数据一条都不丢，
 *   真正搬家交给 migrateAppsLayout()（显式入口，不自动动用户的盘）。 */
function dataDirPointerFile(id, kind) {
  return path.join(appDataRootPath(id, kind), DATA_DIR_POINTER);
}
function readDataDirPointer(id, kind) {
  const roots = [appDataRootPath(id, kind)];
  const old = legacyDataRoot(id);
  if (old && cmpPath(old) !== cmpPath(roots[0])) roots.push(old);
  for (const root of roots) {
    const j = readJson(path.join(root, DATA_DIR_POINTER), null);
    if (!isObj(j)) continue;
    /* 相对名优先（根内目录换数据目录 / 换机器仍认）；只允许根内的**一层**，. / .. 与分隔符不算 */
    const rel = String(j.relative || "").trim();
    if (rel && rel !== "." && rel !== ".." && !/[\\/]/.test(rel)) {
      const abs = path.resolve(path.join(root, rel));
      if (path.dirname(abs) === path.resolve(root)) return { dir: abs, relative: true };
    }
    const d = String(j.dir || "").trim();
    if (d && path.isAbsolute(d)) {
      /* 绝对路径再来一道闸：落在应用目录里的一律不算（老配置被手改坏也不认） */
      const abs = path.resolve(d);
      if (!isInsideAppDir(abs) && abs !== path.parse(abs).root) return { dir: abs, relative: false };
    }
  }
  return null;
}
/* 计算该应用的数据文件夹（不建目录；建目录只在真正要写盘的那几处做） */
function appDataDirOf(id, kind) {
  const p = readDataDirPointer(id, kind);
  return p ? p.dir : appDataRootPath(id, kind);
}
/* 记账用的相对名：默认数据根内 = 相对名（""=根本身），根外 = 绝对路径 */
function dataDirRecord(id, dir, kind) {
  const root = path.resolve(appDataRootPath(id, kind));
  const abs = path.resolve(String(dir || ""));
  if (cmpPath(abs) === cmpPath(root)) return "";
  if (cmpPath(abs).startsWith(cmpPath(root) + path.sep)) {
    return path.relative(root, abs).split(path.sep).join("/");
  }
  return abs;
}
/* 写指针：用户亲自选完才调这里，同时把该目录记进本次进程的写入白名单 */
function writeDataDirPointer(id, dir, kind) {
  const abs = path.resolve(String(dir || ""));
  if (!abs) return bad(t("请选择数据文件夹"), "empty");
  if (abs === path.parse(abs).root) return bad(t("非法路径（磁盘根目录）"), "root");
  if (isInsideAppDir(abs)) return bad(t("数据文件夹不能落在应用目录内"), "app");
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) return bad(t("该路径不是文件夹"), "notdir");
  mk(appDataRootPath(id, kind));
  const record = dataDirRecord(id, abs, kind);
  writeJson(dataDirPointerFile(id, kind), {
    schema: SCHEMA,
    /* dir = 绝对落点（就地解析用）；relative = 根内相对名（换数据目录 / 换机器仍认） */
    dir: abs,
    relative: record && !path.isAbsolute(record) ? record : "",
    updatedAt: Date.now(),
  });
  dataWriteAllow.add(cmpPath(abs));
  mk(abs);
  return { ok: true, id: id, dir: abs, def: false, root: appDataRootPath(id, kind) };
}
/* 默认数据根（不带指针）：给「恢复默认」用 */
function clearDataDirPointer(id, kind) {
  const p = dataDirPointerFile(id, kind);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
  return { ok: true, id: id, dir: appDataRootPath(id, kind), def: true, root: appDataRootPath(id, kind) };
}
/* 该应用当前的写入白名单：默认数据根 + 用户选过的目录 */
function dataAllowList(id) {
  const out = [path.resolve(appDataRootPath(id))];
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
  /* 根目录永远有（没配过就是默认根）：老 storage 只要真躺在那儿就迁，不再看「配没配过」 */
  const { root } = rootPathOf(diskKindOf(id));
  const dir = appDirOf(root, id);
  if (!dir) return { ok: true, moved: false };
  const old = storageFile(dir);
  if (!fs.existsSync(old)) return { ok: true, moved: false };
  const rootDir = appDataRootPath(id);
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
/* 打开该应用的数据文件夹（不存在先建出来，否则资源管理器会报错）。
   kind（"dev" / "down"，可选）＝哪一套根那个副本的数据目录：数据根本来就按类型分两棵
   （apps-data/dev/<id> 与 apps-data/downloaded/<id>），同 id 两边各有一份时开发页要点名 dev。 */
async function openAppDataDir(id, kind) {
  const dir = appDataDirOf(id, kind ? kindOfRoot(kind) : undefined);
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

/* ── 本机多版本台账（台账只记「当前 + 上一版」两个槽，**不存历史载荷**） ──────────
 * 口径（docs/apps-market.md §九）：应用目录永远只有一份活动副本（就是 app.json 那一份），
 * 回滚 = 按台账里记的下载地址 + sha256 **重新下载**那一版再换进来 —— 所以台账只需要
 * 「这一版从哪来」，不需要任何包体。上一版记不下来的情形：本机自建（从没下载过）、
 * 只装过一次、或这一版就是上一版时 —— 一律记 null，回滚入口跟着消失（不编造来源）。 */
function verRecord(version, src, sha256, bytes, uploadedAt) {
  const v = String(version == null ? "" : version).trim();
  const from = String(src == null ? "" : src).trim();
  if (!v || !from) return null;
  return {
    version: v,
    source: from,
    sha256: String(sha256 == null ? "" : sha256).trim(),
    bytes: Number(bytes) || 0,
    uploadedAt: Number(uploadedAt) || 0,
  };
}
/* 台账里的版本槽：只认 { version, source } 齐备的那一份，别的（老账本 / 脏数据）当没有 */
function ledgerSlot(raw) {
  if (!isObj(raw)) return null;
  const v = String(raw.version == null ? "" : raw.version).trim();
  const source = String(raw.source == null ? "" : raw.source).trim();
  if (!v || !source) return null;
  return {
    version: v,
    source: source,
    sha256: String(raw.sha256 == null ? "" : raw.sha256).trim(),
    bytes: Number(raw.bytes) || 0,
    uploadedAt: Number(raw.uploadedAt) || 0,
  };
}
/* 版本槽比对：同一版 = 版本号相同（来源地址不同（静态目录 / 接口两种写法）不算换版） */
function sameVerSlot(a, b) {
  return !!(a && b && String(a.version) === String(b.version));
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
    /* 上架留痕（可选；没上架过为空）：{ id, ownerId, owner, version, at }，见 normCloudPub */
    cloud: normCloudPub(j.cloud),
    /* 设计风格（见本文件顶部 APP_STYLES）：缺字段的老应用 / 云端包一律按默认风格看待，
       写回只发生在部署时给显式风格值的那一条路径上。
       回显走 normStoredAppStyle —— 「自定义」是一个要留给界面与查询记住的值（见该函数） */
    style: normStoredAppStyle(j.style),
    styleSet: String(j.style == null ? "" : j.style).trim() !== "",
    tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
    /* 应用能力位（textInput / imageGen）：清单白名单里**必须**带上它 ——
       漏掉的话卡片小标、「应用能力…」对话框读出来永远是 false（见 apps-capabilities.js） */
    capabilities: normCapabilities(j.capabilities),
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
    /* 上架留痕（本轮需求）：同上 —— 只由显式参数改写，缺省继承目录里已有的那份
       （一次安装 / 更新绝不能把「我上架过这个应用」这件事抹掉）。 */
    cloud: normCloudPub(spec.cloud) || normCloudPub(prev.cloud),
    /* 应用能力位（textInput / imageGen）：只由显式参数改写，缺省继承目录里已有的那份；
       从没声明过的一律 false（存量应用按「不携带语音」处理）—— 见 apps-capabilities.js */
    capabilities: normCapabilities(spec.capabilities == null ? prev.capabilities : spec.capabilities),
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
/* 默认页里可选的语音听写条：只有声明了 capabilities.showDictate 的应用才注入这一份 */
const DICT_JS_TPL = path.join(__dirname, "templates", "app-default", "dict.js");
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
/* 语音听写条（可选）：声明了 showDictate 的应用把 templates/app-default/dict.js **内联**进
   入口页（保持「入口页单文件、离线可用」这条契约：不新增相对资源，也就不怕用户拷走一个 html）。
   没声明 / 模板缺失 → 空串（默认页不带任何语音转文字）。 */
function dictScriptTag(caps) {
  if (!capabilityOn(caps, "showDictate")) return "";
  try {
    const js = fs.readFileSync(DICT_JS_TPL, "utf8");
    if (!String(js).trim()) return "";
    /* 收尾防呆：内联脚本里出现 </script 会提前结束这个 <script> 块（转义掉） */
    return "<script>\n" + String(js).replace(/<\/script/gi, "<\\/script") + "\n</script>";
  } catch (_) {
    return "";
  }
}
function defaultPageHtml(man) {
  const name = String((man && man.name) || (man && man.id) || "应用");
  /* 生成入口页用预设口径：选了「自定义」的应用先落 minimal 那一套（页面绝不花），
     真正的长相由开发会话问清风格要求后改写页面 —— 见 APP_STYLES 里 custom 那一条。 */
  const style = normAppStyle(man && man.style);
  /* 能力位：没声明过的一律 false（存量应用 / 云端包都按「不携带语音」处理） */
  const caps = normCapabilities(man && man.capabilities);
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
        .split("{{DICT_SCRIPT}}")
        .join(dictScriptTag(caps))
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
/* 目录 → 渲染层用的摘要（列表 / 冲突提示 / 变更探测共用同一份口径）。
 * 这里**只看 app.json 的 dev 标记**（唯一真源）：同一个 id 在下载根与项目根各有一份时，
 * 两份常常写着同一份清单字段（用户看对方那一版时把同 id 的装进下载根），于是两边都算「开发中」
 * —— 库页过滤不掉、开发页又会先拿到下载那份（它新、排序在前），用户报的「合并分支后开发项目
 * 在开发会话里消失」就是这么来的。**那一处的裁决在 listApps 的第二遍**（只有同 id 出现两份时
 * 才按「根即身份」改判 kind / dev），这里保持单份口径逐字不变，别把裁决抄第二份。 */
function appSummary(root, id, kindHint) {
  const dir = appDirOf(root, id);
  if (!dir || !fs.existsSync(dir)) return null;
  const man = manifestOf(dir, id);
  const led = readInstalled(dir) || {};
  /* 这个应用算哪一类：**只认 app.json 的 dev 标记**（唯一真源）。
     kindHint = 调用方是从哪一边的根扫到它的，只当「老应用没写过 dev」时的兜底。 */
  const listKind = kindHint ? kindOfRoot(kindHint) : "";
  const kind = kindOfManifest(rawManifestOf(dir), dir) || listKind || APP_KIND_DOWN;
  const stat = dirStatOf(dir);
  const canvas = canvasPathOf(dir, man.name);
  const zip = zipPathOf(dir, man.name);
  return {
    id: id,
    /* 下载的 / 开发的（见 kindOfManifest）：根目录、数据目录、删除范围都按它分 */
    kind: kind,
    kindLabel: kindLabel(kind),
    /* 这次是在哪一边的根下扫到它的（"down" / "dev"） */
    listKind: listKind,
    /* 清单说它是开发的、却躺在下载根里（两边各有一份时最常见）：如实标出来 */
    kindMismatch: !!listKind && listKind !== kind,
    name: man.name,
    version: man.version,
    entry: man.entry,
    description: man.description,
    /* 作者：新建 / 上架时写进 app.json 的登录账号名（空 = 没写过，界面按当前登录账号回落） */
    author: man.author,
    /* 「开发中」（本机自建 / 从库迁移来的）：库页据此过滤，开发页据此列出 —— 真源只有 app.json */
    dev: kind === APP_KIND_DEV,
    /* 数据文件夹（按类型的那一棵；用户改过数据文件夹时是那个绝对路径）：
       渲染层不拼路径、不猜类型，一律读这里与 apps:data* 的回执。 */
    dataDir: (() => {
      try {
        return appDataDirOf(id, kind);
      } catch (_) {
        return "";
      }
    })(),
    /* 二次开发来源（可选）：{ id, ownerId, owner } */
    forkOf: man.forkOf,
    /* 上架留痕（可选）：{ id（云端 id）, ownerId, owner, version, at } ——
       上架窗的默认锁定 id 与离线回落判定都读它（见 renderer/app-apps.js 的
       appsPublishTraceOf / renderer/app-publish.js 的 pubTraceUpdate）。 */
    cloud: man.cloud,
    /* 能力位（app.json 的 capabilities）：卡片小标与「应用能力…」对话框都读这一份 */
    capabilities: normCapabilities(man.capabilities),
    capabilityBadges: capabilityBadges(man.capabilities, appLocale()),
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
    lastRunAt: Number(led.lastRunAt) || 0,
    source: String(led.source || ""),
    sha256: String(led.sha256 || ""),
    /* 本机多版本台账（§九）：cur = 本机这一版的来源（下载地址 / sha256），
       prev = 上一版的版本号 + 来源（**没有载荷**，回滚按它重下）。
       老账本（没有 versions 字段）这里回 null —— 界面据此不画回滚入口，不编造来源。 */
    rollback: (() => {
      const v = isObj(led.versions) ? led.versions : null;
      if (!v) return null;
      const cur = ledgerSlot(v.cur);
      const prev = ledgerSlot(v.prev);
      if (!cur && !prev) return null;
      return { cur: cur, prev: prev, canRollback: !!(prev && cur && prev.version !== cur.version) };
    })(),
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
    /* 应用目录里那个打包 zip（<名称>.zip）的 sha256：同版本号「作者重传了同一版」要靠它判
       「本机这份到底是不是云端那份」（渲染层 appsVersionContentDiffers）。
       台账（installed.json）记着 sha256 的应用用台账那份；**没有台账**的应用（自己新建 / 二次开发）
       从来没有 sha256 可比 —— 这时包就在自己目录里，算一次即可（包不大，且只在渲染层问到时算）。
       算不出来（没有 zip / 读不动）回空串：宁可少一个更新入口，也绝不拿猜的判据说话。 */
    zipSha256: (() => {
      try {
        if (led && led.sha256) return String(led.sha256);
        const zp = zipPathOf(dir, man.name);
        if (!zp || !fs.existsSync(zp)) return "";
        return sha256(fs.readFileSync(zp));
      } catch (_) {
        return "";
      }
    })(),
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
   dev（开发中）/ author（作者）/ forkOf（二次开发来源）/ cloud（上架留痕）。
   省略的键保持原样，绝不整份重写。 */
function setAppMeta(arg) {
  const a = isObj(arg) ? arg : {};
  const id = safeAppId(a.id);
  if (!id) return bad(t("应用 id 不合法"), "bad_id");
  /* 类型：显式传了就用它，没传按本机实际所在的那一边（两套根都看一眼）。
     目录一律走 dirOfApp（按类型 + 两套根兜底）：**改 dev 标记本身不改目录**，
     物理搬家由 apps:migrateLayout 那一处显式入口负责（见「二次开发」流程）。 */
  const kind = a.kind ? kindOfRoot(a.kind) : diskKindOf(id);
  const dir = dirOfApp(id);
  if (!dir || !fs.existsSync(dir))
    return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: id });
  const raw = readManifest(dir);
  if (!raw) return bad(t("应用清单损坏（app.json 读不出来）：先修好它再改这些信息"), "broken_manifest");
  const patch = {};
  if (typeof a.dev === "boolean") patch.dev = a.dev;
  if (a.author !== undefined) patch.author = String(a.author == null ? "" : a.author).trim();
  if (a.forkOf !== undefined) patch.forkOf = normForkOf(a.forkOf);
  /* 上架留痕（本轮需求）：传 null / 空对象 = 抹掉（留痕可以被清掉，绝不留半条脏数据） */
  if (a.cloud !== undefined) patch.cloud = normCloudPub(a.cloud);
  if (!Object.keys(patch).length) return bad(t("没有要写入的字段"), "no_fields");
  try {
    writeJson(manifestPath(dir), Object.assign({}, raw, patch));
  } catch (err) {
    return fail(err);
  }
  /* 改了 dev 就等于换了类型：先回**现在**这一边的摘要（下一次 list 会按新类型归位） */
  const nowKind = kindOfManifest(Object.assign({}, raw, patch), dir);
  return {
    ok: true,
    id: id,
    kind: nowKind,
    kindChanged: nowKind !== kind,
    patched: Object.keys(patch),
    app: appSummary(path.dirname(dir), id, nowKind),
  };
}
/* ── 云端条目元数据 → 本机副本（apps:syncCloudMeta 的唯一实现）────────────────────
 * 用途：应用中心里改过的**云端条目**（标题 / 简介 / 标签）要落到本机所有同 id 副本上，
 * 免得本机列表还显示老标题、搜索还按老标签命中。
 *
 * 与 setAppMeta 的分工（**语义不重叠，绝不合流**）：
 *   · setAppMeta  = 本机状态字段（dev / author / forkOf），只写 dirOfApp 那**一处**；
 *   · 本函数     = 云端条目字段（title / description / tags），写**两套根下的每一份同 id 副本**。
 *
 * 可写字段白名单（只写传进来的那几个键，缺省的键一律不动）：
 *   title       字符串（同一个值**同时**写进 app.json 的 title 与 name —— 本机列表、窗口标题、
 *               画布文件名都读 name，只改 title 会出现「界面新标题、文件名还是老的」）；
 *   description 字符串（原样，不 trim —— 简介里的换行与缩进由作者自己定）；
 *   tags        字符串数组（逐项去空白、丢空项、去重且保持原顺序；传 [] = 清空）。
 * 明确**不写**（这些是本机自己的事，云端条目说了不算）：icon / dev / forkOf / cloud / capabilities /
 * style / entry / version / createdAt / updatedAt —— 冒烟按这份清单逐键比对面（见 [2]）。
 *
 * 两套根**都扫**：同一个 id 完全可能在下载根与项目根各有一份（用户口径：两边都要跟上），
 * 所以绝不能只写 dirOfApp(id) 那一处；rootsInfo() 里两套根配成同一个目录时只扫一次。
 *
 * 回执形状（**单条失败不抛**，写不动的副本记进该条 error 后继续写其余副本；
 * 全失败仍然 ok:true —— 由渲染层按 results 里的 error 单独提示）：
 *   { ok:true, id, synced:<写成功条数>, missing:<本机一份都没有时为 true>,
 *     results:[{ dir, kind, ok, error? }] }
 * 本机没有该应用不是错误：{ ok:true, id, synced:0, missing:true, results:[] }。
 * kind 口径：app.json 显式写过 dev 标记就用它；没写过按「扫到它的那一套根」归位。 */
function syncArrayOfTags(v) {
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const s = String(x == null ? "" : x).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
function syncCloudMetaToLocal(arg) {
  const a = isObj(arg) ? arg : {};
  const id = safeAppId(a.id);
  if (!id) return bad(t("应用 id 不合法"), "bad_id");
  /* 只认白名单里的三个键；title 交上来了就必须是非空字符串（绝不把空标题写进清单） */
  const patch = {};
  if (a.title !== undefined) {
    const title = typeof a.title === "string" ? a.title.trim() : "";
    if (!title) return bad(t("标题不能为空"), "empty_title");
    patch.title = title;
    patch.name = title;
  }
  if (a.description !== undefined) patch.description = String(a.description == null ? "" : a.description);
  if (a.tags !== undefined) patch.tags = syncArrayOfTags(Array.isArray(a.tags) ? a.tags : []);
  if (!Object.keys(patch).length) return bad(t("没有要写入的字段"), "no_fields");

  let roots = {};
  try {
    roots = rootsInfo();
  } catch (_) {
    roots = {};
  }
  const results = [];
  const seenRoot = new Set();
  let synced = 0;
  for (const k of APP_KINDS) {
    const root = String(((roots || {})[k] || {}).path || "");
    if (!root) continue;
    /* 两套根配成同一个目录（用户还没分开）= 只扫一次，绝不重复写同一个 app.json */
    const key = cmpPath(root);
    if (!key || seenRoot.has(key)) continue;
    seenRoot.add(key);
    const dir = appDirOf(root, id);
    if (!dir || !fs.existsSync(dir)) continue; /* 这一边没有这个 id：不是错误 */
    let raw = null;
    let broken = "";
    try {
      raw = readManifest(dir);
    } catch (err) {
      raw = null;
      broken = String((err && err.message) || err);
    }
    if (!raw) {
      /* 清单损坏（读不出 / 不是对象）：这一条记 error，接着写别的副本 */
      results.push({
        dir: dir,
        kind: k,
        ok: false,
        error: t("应用清单损坏（app.json 读不出来）：") + (broken || t("内容不是 JSON 对象")),
      });
      continue;
    }
    try {
      writeJson(manifestPath(dir), Object.assign({}, raw, patch));
      synced++;
      results.push({ dir: dir, kind: k, ok: true });
    } catch (err) {
      results.push({ dir: dir, kind: k, ok: false, error: String((err && err.message) || err) });
    }
  }
  return {
    ok: true,
    id: id,
    kind: a.kind ? kindOfRoot(a.kind) : diskKindOf(id),
    synced: synced,
    missing: results.length === 0,
    patched: Object.keys(patch),
    results: results,
  };
}
/* 本机应用列表：**两套根都扫**（下载的 + 开发的），每条带自己的 kind / 根 / 数据目录。
 * 两套根配成同一个目录时（用户还没分开）只扫一次，按各应用自己的 dev 标记归位。
 * **按「根」去重，绝不按 id 去重**（用户报的 bug：同 id 在下载根与项目根各有一份时，
 * 先扫的下载根把项目根那一份吞掉，而那条 `dev:true` 清单字段两边共用 —— 结果是**两边都不像**
 * 开发中的应用：库页过滤不掉它，开发页又只看得到下载那份 → 开发会话里「合并分支后项目消失」。
 * 判据：同一个 id 出现在**两套不同的根**下 = 两份互不相同的应用（下载的那份 + 我开发的那份），
 * 两份都列；只有两套根指向同一个目录时才按 id 去重（那就是同一份文件，列两次纯属重复）。
 * **列应用 = 「真正要用到根」的第一处**：没配过时在这里把默认根固化进 config.json
 * （见 ensureRootPersisted），所以库页 / 开发页一打开，两个根就是明确可用的路径。 */
function listApps() {
  for (const k of APP_KINDS) ensureRootPersisted(k);
  const roots = rootsInfo();
  /* 两套根配成同一个目录 → 只扫一遍（按 id 去重）；两套根不同 → 每一边独立按 id 去重，
     同 id 的两份都列（哪一份算 dev 见下面第二遍）。 */
  const sameRoot = (() => {
    const a = cmpPath(String((roots[APP_KIND_DOWN] || {}).path || ""));
    const b = cmpPath(String((roots[APP_KIND_DEV] || {}).path || ""));
    return !!a && a === b;
  })();
  /* 第一遍：**只看清单**（老口径逐字不变）—— 一份应用算哪一类仍由 app.json 的 dev 标记说话。 */
  const seenId = new Set();
  const perRoot = APP_KINDS.map((k) => {
    const root = String((roots[k] || {}).path || "");
    const out = [];
    if (!root || !fs.existsSync(root)) return out;
    let ents = [];
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {}
    const seenHere = new Set();
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const id = safeAppId(ent.name);
      if (!id) continue;
      const key = String(id).toLowerCase();
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      if (sameRoot && seenId.has(key)) continue;
      seenId.add(key);
      devBackfillOnce(root, id);
      /* 已经登记为「移除过」的开发应用不再列（用户主动摘掉的登记，不自动回来） */
      if (rawManifestOf(path.join(root, id))?.removed === true) continue;
      const s = appSummary(root, id, k);
      if (s) out.push(s);
    }
    return out;
  });
  const apps = [].concat(...perRoot);
  /* 第二遍：**只有「同一个 id 在另一套根里也有一份」时才让根说话**（本轮修的 bug）——
     两份文件的 app.json 常常是同一份（用户看别人那一版时把同 id 的装进下载根），只看清单的话
     两边都算「开发中」：库页过滤不掉、开发页又会先拿到下载那份（它新、排序在前）→ 用户报的
     「合并分支后开发项目在开发会话里消失」。这时按「根即身份」把下载根那份改判成 down
     （清单与根不一致的事实由 kindMismatch 如实标出），项目根那份留作 dev。
     **只有一份的应用一律不动**（老口径逐字不变：清单说开发就是开发，哪怕它躺在下载根里）。 */
  if (!sameRoot) {
    const cnt = Object.create(null);
    for (const s of apps) {
      const key = String(s.id).toLowerCase();
      cnt[key] = (cnt[key] || 0) + 1;
    }
    for (const s of apps) {
      if (cnt[String(s.id).toLowerCase()] < 2) continue;
      if (s.listKind === APP_KIND_DOWN) {
        s.kind = APP_KIND_DOWN;
        s.kindLabel = kindLabel(APP_KIND_DOWN);
        s.dev = false;
      } else if (s.listKind === APP_KIND_DEV) {
        s.kind = APP_KIND_DEV;
        s.kindLabel = kindLabel(APP_KIND_DEV);
        s.dev = true;
      }
    }
  }
  apps.sort((a, b) => (b.installedAt || b.mtimeMs) - (a.installedAt || a.mtimeMs));
  const down = roots[APP_KIND_DOWN] || {};
  return {
    ok: true,
    /* 老字段（一批老调用点读它 = 下载根）：兼容保留，不删 */
    root: String(down.path || ""),
    configured: !!down.configured,
    exists: !!down.exists,
    /* 新口径：两套根的完整信息 + 每条应用自己的 kind / 数据目录 */
    roots: roots,
    apps: apps,
    at: Date.now(),
  };
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
    /* 新建应用 = 开发的应用：一律落在**项目根**（apps.projectDir，默认 <数据目录>/apps-dev），
       绝不再往下载根里塞（用户口径：下载的与开发的严格分开）。
       没配过项目根不再拦人（也不弹选目录框）：用默认根并当场固化（本轮口径）。 */
    root = ensureRootPersisted(APP_KIND_DEV).root;
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
      { id: id, name: name, version: "1.0.0", style: a.style, dev: true, author: a.author, capabilities: a.capabilities },
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
    /* 应用可能在哪一边：按本机实际所在的那一类取根 */
    const k = a.kind ? kindOfRoot(a.kind) : diskKindOf(id);
    root = rootPathOf(k).root;
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
    /* 画布镜像跟着应用自己的那一类走：开发的应用镜像进项目根，下载的进下载根 */
    dir = dirOfApp(sid);
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
   **接口目录**的 versions[].zipUrl 是静态写法（<id>/<作者>/<ver>.zip），静态目录里并不存在那个文件，
   必须换成接口的 /api/apps/<id>/file?owner=<作者uid>&version=<ver>&format=raw；静态目录则原样用。
   同 id 多分支（docs/apps-market.md §十）：**owner 参数必须带上**（同一 id 下每个作者一份包），
   条目没有 ownerId 时（老静态目录）退回不带 owner 的老写法，行为与以前一致。 */
function zipUrlsOf(spec) {
  const id = String((spec && spec.id) || "");
  const base = specBaseOf(spec);
  const api = isApiSpec(spec);
  const version = String((spec && spec.version) || "");
  const owner = String((spec && spec.ownerId) || "").trim();
  const ownQ = owner ? "owner=" + encodeURIComponent(owner) : "";
  const q = (...parts) => {
    const list = parts.filter(Boolean);
    return list.length ? "?" + list.join("&") : "";
  };
  const out = {
    zip: api
      ? base + "/api/apps/" + encodeURIComponent(id) + "/file" + q(version ? "version=" + encodeURIComponent(version) : "", ownQ, "format=raw")
      : resolveZipUrl(spec && spec.zipUrl, base),
    versions: {},
    icon: "",
  };
  for (const v of ((spec && spec.versions) || [])) {
    if (!v || !v.version) continue;
    out.versions[v.version] = api
      ? base + "/api/apps/" + encodeURIComponent(id) + "/file" + q("version=" + encodeURIComponent(v.version), ownQ, "format=raw")
      : resolveZipUrl(v.zipUrl, base);
  }
  const raw = String((spec && spec.icon) || "").trim();
  if (raw) {
    if (/^data:image\//i.test(raw)) out.icon = raw;
    else if (/^https?:\/\//i.test(raw)) out.icon = resolveZipUrl(raw, base);
    else if (api) {
      /* 接口目录的 icon 是相对接口的写法（icons/<id>__<作者>.<ext> / 裸文件名）→ 统一走 /api/apps/<id>/icon。
         base 已过白名单（只有 FEED / STORE_BASE 会挂上来），不会被目录内容换成别的站。 */
      const rel = raw.replace(/^\.\//, "");
      out.icon =
        rel.indexOf("/") <= 0 || rel.startsWith("icons/")
          ? base + "/api/apps/" + encodeURIComponent(id) + "/icon" + q(ownQ)
          : resolveZipUrl(rel, base);
    } else out.icon = resolveZipUrl(raw, base);
  }
  /* 封面缩略图（卡片 16:9 背景图）：服务端条目下发 `thumb`（相对静态目录 icons/<主干>[__shot].png，
     源 = 上架截图第 1 张，见 store-saas/server.mjs 的 appCatalogEntry）。**服务端两种来源下发的是
     同一个字段**（同一份 appCatalogEntry），文件名后缀代表封面源（截图 / 图标），所以：
       · 静态目录：原样解析成 FEED + 它；
       · 接口目录：本地写法在接口侧**不存在**（icons/ 属于静态目录），接口只有
         /api/apps/<id>/thumb 一条路由（它自己知道封面源）—— 与 icon 完全同一套写法。
         以前这里按 base 直拼（…/store-api/icons/<主干>__shot.png），线上是 404：
         封面先白跑两次请求，再一路退到「原图 → 图标」，卡片上就等于拿不到封面。
     老目录没有这个字段时留空，渲染层仍会退回 icon（appsThumbUrlOf 那条既有链路）。 */
  const rawThumb = String((spec && spec.thumb) || "").trim();
  if (rawThumb) {
    if (/^data:image\//i.test(rawThumb)) out.thumb = rawThumb;
    else if (/^https?:\/\//i.test(rawThumb)) out.thumb = resolveZipUrl(rawThumb, base);
    else if (api) {
      const relT = rawThumb.replace(/^\.\//, "");
      out.thumb =
        relT.indexOf("/") <= 0 || relT.startsWith("icons/")
          ? base + "/api/apps/" + encodeURIComponent(id) + "/thumb" + q(ownQ)
          : resolveZipUrl(relT, base);
    } else out.thumb = resolveZipUrl(rawThumb, base);
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
    /* 上传者显示名（服务端按上传者 uid 实时解析的昵称；老目录没有 = 空串：
       渲染层拿不到它就退账号名，占位名 / uid 一律不出现在界面上，见 renderer/app-apps.js） */
    uploaderName: String(v.uploaderName || fb.uploaderName || "").trim(),
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
  /* 封面来源：只认 shot / icon 两个值，别的一律当"没声明"（老目录） */
  const rawCover = String(s.coverSource || "").trim();
  const coverSource = rawCover === "shot" || rawCover === "icon" ? rawCover : "";
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
    /* 上架截图（多图）：目录条目下发的相对静态目录写法数组（shots/<主干>/<n>.<ext>）。
       渲染层拿它画详情窗的多图画廊；老目录没有这个字段 = 空数组（画廊不出现，其余一切照旧）。
       shotsThumb[] = **同一批图的列表小图**（长边 1280，服务端懒生成）：列表页只下它，
       详情才下 shots[] —— 图片放宽到 5MB 之后，这条是列表页不把带宽吃光的关键。
       位置对不上 / 老目录没有 → 空串，渲染层退回原图地址（绝不 404）。
       shotsSha[] = 每张图的内容哈希（服务端内容寻址图片库的对象名）：客户端据此判断
       「云端已经有这张图」，重复提交时只发引用不发字节。 */
    shots: (Array.isArray(s.shots) ? s.shots : [])
      .map((x) => String(x == null ? "" : x).trim())
      .filter(Boolean),
    shotsThumb: (Array.isArray(s.shotsThumb) ? s.shotsThumb : []).map((x) =>
      String(x == null ? "" : x).trim(),
    ),
    shotsSha: (Array.isArray(s.shotsSha) ? s.shotsSha : [])
      .map((x) => String(x == null ? "" : x).trim().toLowerCase())
      .filter((x) => /^[0-9a-f]{64}$/.test(x)),
    /* 封面（卡片 16:9 背景图，本轮需求）：服务端下发**封面源就是上架截图第 1 张**——
       thumb = 缩略图相对地址（icons/<主干>__shot.png / 没有截图才 icons/<主干>.png）；
       coverSource = "shot" | "icon"（没有封面图 = 空串）；coverVer = 封面源文件 mtime（秒），
       换图后立刻换地址、绕开 HTTP 缓存（作者在「编辑」里换截图不产生新版本号，版本号当令牌不够用）。
       老目录没有这三项：thumb 空 → 渲染层退回按 icon 推导，行为与以前完全一致。 */
    thumb: String(s.thumb || "").trim(),
    coverSource: coverSource,
    coverVer: String(s.coverVer || "").trim(),
    window: isObj(s.window) ? s.window : {},
    /* 多版本（§七）：latestVersion 缺省 = version；versions[] 缺省 = 就这一版 */
    owner: String(s.owner || "").trim(),
    /* 作者显示名（昵称，服务端按 uid 实时解析；老目录 / 接口没有 = 空串）——
       界面显示一律用它，`owner` 只留给「同作者」判定与下载寻址（见 renderer/app-apps.js 的
       appsAuthorOf / appsSameAuthor）。 */
    ownerName: String(s.ownerName || "").trim(),
    /* 来源作者 uid（接口条目带 ownerUser.id；静态目录只有 username，那就空着）——
       「更新按钮只在同作者时出现」靠它判，判定口径见 docs/apps-market.md §八。 */
    ownerId: String(s.ownerId || (isObj(s.ownerUser) && s.ownerUser.id) || "").trim(),
    /* 二次开发来源（可选）：{ id, ownerId, owner } —— 同一源应用的不同作者分支按它归组 */
    forkOf: normForkOf(s.forkOf),
    /* 应用家族（本轮需求：分支树统一 · 打赏 / 评论按根应用统一）——
       服务端在目录条目与 branches[] 里下发这三项，客户端据此把「同一个应用族」的条目
       合并成一张卡、画多层分支树（父挂在 parentOwnerId 那条下面）：
         familyRootId = 家族归组 id（= 根条目的 id）；trunk = 这条是不是根；
         parentOwnerId = 它基于哪条分支开发。老目录没有这三项 → 客户端退回按 id 归组。 */
    familyRootId: String(s.familyRootId || "").trim(),
    trunk: s.trunk === true,
    parentOwnerId: String(s.parentOwnerId || "").trim(),
    latestVersion: String(s.latestVersion || version).trim() || version,
    versions: normVersionsOf(s, single),
    /* 条目最后更新时间（本轮需求：应用详情右列要显示「更新时间」）：
       服务端目录条目本来就下发 updatedAt（store-saas/server.mjs 的 appCatalogEntry），
       但这里过去没有透传 → 渲染层的目录条目根本没有这个字段（只有「我的应用」那条
       路径靠 appsSpecFromMine 留着）。**数字串 / ISO 串都收**（手写静态目录常写 ISO），
       认不出来就是 0 = 「没有这个字段」，由渲染层决定退不退版本时间、画不画这一行。 */
    updatedAt: normStamp(s.updatedAt),
    /* createdAt（本轮补透传，服务端 appCatalogEntry 一直有它）：渲染层按「createdAt 最早」
       挑家族主干（原作者那条，见 renderer/app-apps.js 的 appsFamilyRootOf），过去这里没透传 →
       客户端所有条目的 createdAt 都是「没有」＝ MAX_SAFE_INTEGER，择优退化成「取列表第一个」，
       原作者就可能指到别人那条分支；分支行上的时间也跟着永远空着。 */
    createdAt: normStamp(s.createdAt),
  };
}
/* 目录里的时间戳归一：数字 / 数字串 / ISO 串 → 毫秒；认不出回 0（绝不编造时间）。
   口径与渲染层 appsStampOf（renderer/app-apps.js）一致：**2000-01-01 之前的值当没有** ——
   手写清单里塞 0 / 1 / 2 这类占位值很常见，放过去界面就会显示「1970/1/1」。 */
const NORM_STAMP_MIN = 946684800000;
function normStamp(v) {
  if (typeof v === "number") return isFinite(v) && v >= NORM_STAMP_MIN ? v : 0;
  const s = String(v == null ? "" : v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return isFinite(n) && n >= NORM_STAMP_MIN ? n : 0;
  }
  const t = Date.parse(s);
  return isFinite(t) && t >= NORM_STAMP_MIN ? t : 0;
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
/* 「云端**答了**、只是 0 条」与「连不上」必须分得开：前者不是错误 —— 客户端不该拿它说
   「请检查网络」（用户实际白查一遍网络，2026-10-09 报的那句就是这么来的）。
   空目录本身仍按失败处理（见 fetchRemoteCatalog 的注释：要回退下一层），
   但失败码认得出（EMPTY_CATALOG），loadCatalog 据此在结果里记一个 answered 交给渲染层。 */
function emptyCatalogErr(what) {
  const e = new Error("empty_catalog（" + what + " 0 条）");
  e.code = "EMPTY_CATALOG";
  return e;
}
function isEmptyCatalogErr(err) {
  return !!(err && err.code === "EMPTY_CATALOG");
}
/* 「一层都没成」时的结果对象（纯函数，冒烟直接真跑）：
   errors = 各层失败原文（只进日志 / 排查），answered = 云端真答过（哪怕 0 条）。
   渲染层只认 source + answered 两个字段：answered=true 时它一个字都不说（0 条不是错误），
   false 才说一句「无法连接」（见 renderer/app-apps.js 的 appsCatalogDown）。 */
function emptyCatalogResult(errors, answered) {
  return {
    ok: true,
    source: "empty",
    fetchedAt: 0,
    sourceUrl: catalogUrl(),
    sourceBase: FEED,
    apps: [],
    appVersion: String(getAppVersion() || ""),
    remoteError: (errors || []).join(" · "),
    answered: answered === true,
  };
}
/* 静态目录（首选入口）：拉不到 / 是空目录都算失败 —— 空目录正是「部署链把线上目录刷空」
   那类事故的样子，必须让调用方回退接口目录，而不是把「一条应用都没有」当结论。 */
async function fetchRemoteCatalog() {
  const buf = await fetchBuffer(catalogUrl(), null, MAX_CATALOG);
  const doc = JSON.parse(buf.toString("utf8"));
  if (!isObj(doc) || !(Array.isArray(doc.apps) || Array.isArray(doc.list))) throw new Error("bad_catalog");
  const parsed = parseCatalogDoc(doc, FEED, "static");
  if (!parsed.apps.length) throw emptyCatalogErr("静态目录");
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
   每一层都记进日志（source / remoteError），排查「应用库没连上云端」时一眼能看出断在哪一层。
   结果里的 answered = 「云端确实回了一份目录（哪怕 0 条）」——渲染层只对 answered=false 的
   那种空目录说「无法连接」，云端就是没应用时不再误导用户去查网络（见 app-apps.js 的
   appsCatalogDown）。 */
async function loadCatalog() {
  const errors = [];
  let answered = false;
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
    if (isEmptyCatalogErr(err)) answered = true;
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
    if (!out.apps.length) throw emptyCatalogErr("接口目录");
    console.log(
      "[apps-store] 静态目录不可用（" + errors.join(" · ") + "）→ 已回退云端接口目录：" +
        storeCatalogUrl() + "（" + out.apps.length + " 个应用）",
    );
    return out;
  } catch (err) {
    if (isEmptyCatalogErr(err)) answered = true;
    errors.push("api: " + ((err && err.message) || err));
  }
  const c = readCatalogCache();
  if (c && c.doc) {
    const out = catalogFromCache(c, errors.join(" · "));
    console.warn("[apps-store] 云端目录拉不到（" + out.remoteError + "）→ 显示本机缓存：" + out.sourceUrl);
    return out;
  }
  console.warn("[apps-store] 云端目录拉不到、本机也没有缓存：" + errors.join(" · "));
  /* answered 见 emptyCatalogResult 的注释：两层都是 empty_catalog → true（云端就是没应用），
     两层都真的没连上 → false。渲染层据此决定说不说「无法连接」。 */
  return emptyCatalogResult(errors, answered);
}
/* 找一个目录条目：先缓存、再远端（安装时云端刚更新过也能装上）。
   同 id 多分支（docs/apps-market.md §十）：同一个 id 下每个作者一条，**必须按 ownerId 区分** ——
   传了 ownerId 就只认那一条；不传则回主干（目录里同 id 的第一条，服务端也是这个缺省语义）。
   返回 { spec, reachable }：spec = 命中的条目（没有 = null）；reachable =「云端目录这次到过」。
   安装路径靠 reachable 把「云端确实没有它（下架 / 已删）」与「这次没连上云端」分开报，
   两者的出路完全不同（见 apps-store.js 的 installCatalogMiss 与 renderer 的 appsErrText）。 */
async function findSpecHit(id, ownerId) {
  const want = String(ownerId || "").trim();
  const pick = (list) => {
    const arr = Array.isArray(list) ? list : [];
    if (want) return arr.find((a) => a && a.id === id && String(a.ownerId || "") === want) || null;
    return arr.find((a) => a && a.id === id) || null;
  };
  /* ① 本机缓存的最快路径（命中就直接用，不走网络 —— 老行为不变）。
     只认**当前目录地址**下的那一份缓存：缓存可能是上一次会话 / 另一台实例 / 另一个目录基址
     留下的（catalogCachePath 只有一份），照它解析出来的下载地址是那个旧基址的，
     拿到今天的客户端上就是连不上旧实例 / 打到别人的包 —— 那类缓存在这里直接不用。
     命中的条目按**当前**来源基址重新解析地址（tagSourceBase 就是这么挂的）：
     缓存里存的相对路径（<id>__<作者uid>.zip、<id>/<版本>.zip）今天还按同一个基址取。 */
  const cached = readCatalogCache();
  const cachedFresh =
    !!cached &&
    !!cached.doc &&
    String(cached.sourceUrl || "") === catalogUrl() &&
    String(cached.sourceKind || "static") === "static";
  const cachedHit = cachedFresh ? pick(parseCatalogDoc(cached.doc, cached.sourceBase, cached.sourceKind).apps) : null;
  if (cachedHit) return { spec: tagSourceBase(cachedHit, FEED, "static"), reachable: true };
  /* ② 缓存里没有它 → 真的问一次目录（loadCatalog 自带 静态 → 接口 → 缓存 → 空 的降级链） */
  const cat = await loadCatalog();
  const hit = pick(cat && cat.apps);
  if (hit) return { spec: hit, reachable: true };
  /* ③ 没命中：只有「云端真答了一份目录」才算到过 —— remote / api 是当场答的，
     cache 是上一份真目录（里面没有它就是真没有），空目录 / 一层都没拉通 = 没到过。 */
  const source = String((cat && cat.source) || "");
  return { spec: null, reachable: source === "remote" || source === "api" || source === "cache" };
}
/* 兼容旧调用点：只要条目（安装路径要的 reachable 走 findSpecHit）。 */
async function findSpec(id, ownerId) {
  const hit = await findSpecHit(id, ownerId);
  return hit.spec;
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
/* 包内条目的时间戳**固定**（1980-01-01 00:00:00，DOS 时间戳下界）——本轮需求：
   「同一个应用打两次包 = 字节完全一样」（目录内容不变时）。
   以前每个条目写的是**打包那一刻**（`new Date()`，DOS 时间戳 2 秒粒度），于是同一份目录、
   同一个口径连打两次也会换 sha256：客户端「打包 → 读回」比对随机失败（用户报的那个错的一半），
   服务端「这次带的包与线上那一版内容一模一样」判定（store-saas/server.mjs 的
   `zipSha === a.sha256`）也永远不成立。
   代价只有一处、且无害：解压出来的文件时间显示为这个固定值 —— 安装解压实现（unzipBuffer）
   根本不读包内时间字段，应用运行也不依赖它。 */
const ZIP_FIXED_STAMP = { time: 0, date: (1 << 5) | 1 };
/* 最小 zip 打包器（deflateRaw 优先，压不动就 store）：只打我们自己挑好的文件，
   不引第三方依赖。UTF-8 名字置 flag 0x0800（中文 <AppName> 也能被解压工具认。）
   **字节可复现**：条目顺序由调用方固定（packEntriesOf 按相对路径字典序），时间戳走
   ZIP_FIXED_STAMP，deflate 对同一份输入确定 —— 同内容 ⇒ 同字节 ⇒ 同 sha256。 */
function zipBuffer(entries) {
  const now = ZIP_FIXED_STAMP;
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
  /* 这一条必须在 ^not_in_catalog 之前（否则被那条前缀先接走）：云端目录里没有它
     （作者已删除），拿不到要装的那一版的下载地址（见 installCatalogMiss）。
     措辞对两种人都要成立：本机装过的（重下没了来源）与**从没装过的**（别人分享的 id /
     本机缓存里的旧卡片）—— 原来那句「本机这一份没法再重新下载」在后一种人那儿是句
     没头没脑的话，他本机根本没有这一份。 */
  if (/^not_in_catalog_removed/.test(s)) return "云端目录里已经找不到这个应用（作者已删除），没法再从云端下载";
  if (/^catalog_unreachable/.test(s)) return "这次没能连上云端目录：检查网络后重试；离线时只有本机已有的版本能在本机切换";
  if (/^not_in_catalog/.test(s)) return "云端目录里找不到这个应用";
  if (/^version_not_in_catalog/.test(s)) return "云端目录里找不到这个版本（作者可能已删除该版本）";
  if (/^need_app_update/.test(s)) return "该应用要求的 MTNode 版本高于当前版本";
  if (/^pack_missing_entry/.test(s)) return "安装包解压后缺少入口 HTML（云端包结构不对）";
  if (/zip truncated|unsupported zip method/.test(s)) return "安装包损坏或压缩方式不受支持";
  if (/^bad_id/.test(s)) return "应用 id 不合法";
  if (/^EACCES|^EPERM|^ENOENT|^ENOSPC/.test(s)) return "写入应用目录失败（" + s + "）";
  return "";
}
/**
 * 「这一步其实是云端目录里没有它」的判据（安装路径专用）。
 *
 * 现场（用户报「上传应用后，其他用户下载时显示下载失败：云端目录里找不到」）：
 * 这一步原先会报 bad_zip_url，用户看到的是「云端目录里该应用的下载地址不合法」——
 * 与真实原因（云端没有它：已下架 / 已删除）完全对不上，照着这句话也修不了。
 * 现在主路径已经在 throw 之前就把两种情形分开报（见 installApp 里那段注释与
 * findSpecHit 的 reachable），这里留作**兜底**：只要走到「要下它、却拿不到下载地址」，
 * 就按这一条说清楚，而不是回一句把人引向错误方向的「地址不合法」。
 *
 * 判据只看 spec 有没有**云端身份**：没有 zipUrl、也没有 versions[] / ownerId 的，一定是
 * 本机那份清单（app.json 只写展示与状态字段）或半截条目 —— 那不是「地址坏了」，是「没地址」。
 * 有 zipUrl / versions / ownerId 就说明它是真目录条目，那空地址就是真的坏地址，仍报 bad_zip_url。
 * 返回失败码或 ""（"" = 不归这条管，调用方照旧报 bad_zip_url）。
 *
 * catReachable 决定措辞：目录这次到过 = 云端确实没有它（多半被删 / 下架，not_in_catalog_removed）；
 * 没到过 = 离线 / 弱网（catalog_unreachable）—— 两种情形用户该做的事不一样。
 */
function installCatalogMiss(spec, catReachable) {
  if (!spec) return "";
  if (String(spec.zipUrl || "").trim()) return "";
  if (Array.isArray(spec.versions) && spec.versions.length) return "";
  if (String(spec.ownerId || "").trim()) return "";
  return catReachable === false ? "catalog_unreachable" : "not_in_catalog_removed";
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
  /* 安装 = **只动下载根**（云端目录下来的东西绝不进项目根；用户口径：两套根严格分开）。
     没配过根目录不再拦人：用默认根（<数据目录>/apps）并当场固化（本轮口径，见 ensureRootPersisted）。 */
  const { root } = ensureRootPersisted(APP_KIND_DOWN);
  if (installing[id]) return Object.assign(bad(t("该应用已有安装任务在跑"), "busy"), { busy: true });
  installing[id] = true;
  const mode = String(a.mode || "").trim();
  sendProgress({ id: id, phase: "start", percent: 0 });
  try {
    mk(root);
    /* 直连地址（本机多版本回滚走这条）：台账里记着那一版**那次真正的下载地址**，
       云端目录可能已经改版 / 下架，找不到那一版就按台账直连 —— 但守卫一条不少：
       地址仍要过 resolveZipUrl 白名单，sha256 仍要校验（见 §九）。 */
    let directUrl = String(a.directUrl || "").trim();
    let directRaw = String(a.sha256 || a.directSha || "").trim();
    /* 覆盖安装 / 更新前先读一把**本机**清单与安装账本：dev（开发中）/ forkOf（来源）/
       本机多版本台账都只存在于本机目录里，云端包与目录都没有 —— 必须在 removePayload
       抹掉 app.json 之前取到（否则一次更新就会让应用从「开发」页退回「库」页）。 */
    const keepMan = readManifest(appDirOf(root, id) || "") || {};
    const oldLedger = readInstalled(appDirOf(root, id) || "") || {};
    let spec = null;
    /* 目录**到过**没有（findSpecHit 的 reachable）：用来分开「云端确实没有这个应用」与
       「这次没连上云端」—— 两种情形的失败码与提示都不一样（见下面那段的注释）。 */
    let catReachable = false;
    /* 要装哪一版（渲染层点版本树里的某一版；空 = 当前版）—— 目录兜底与台账兜底都要用，先定。 */
    let wantVersion = String(a.version || "").trim();
    if (!directUrl) {
      /* 同 id 多分支：ownerId 指明要装哪条分支（不传 = 主干），见 docs/apps-market.md §十 */
      const hit = await findSpecHit(id, a.ownerId);
      spec = hit.spec;
      catReachable = hit.reachable;
      /* 目录里没有它：**分两种情形说**，别混着报（现场：用户看到的那句话与真实原因对不上）——
         ① 目录这次到过（云端确实没有它：已下架 / 已删除）→ not_in_catalog_removed；
         ② 目录这次没到过（离线 / 弱网）→ catalog_unreachable —— 「作者下架」与「你没连上网」
            是两件事，报错了用户按哪句话修都不一样。
         两种情形都先看本机台账：installed.json 里记着这一版**那次真正的下载地址**
         （versions.cur，回滚那条路维护）→ 按台账直连重下，离线时的版本切换 / 重装照样走得通。
         **不拿本机 app.json（keepMan）当下载依据**：它没有 zipUrl / sha256（writeManifest 只写
         展示与状态字段），照它拼出来的地址必然是空的 —— 那就是「云端目录里该应用的下载地址
         不合法」那句错报的来路。 */
      if (!spec && (catReachable || String(oldLedger.source || "").trim())) {
        const ledCur = ledgerSlot(isObj(oldLedger.versions) ? oldLedger.versions.cur : null);
        const src = String(oldLedger.source || (ledCur && ledCur.source) || "").trim();
        if (src) {
          directUrl = src;
          directRaw = String(oldLedger.sha256 || (ledCur && ledCur.sha256) || "") || directRaw;
          if (!wantVersion) wantVersion = String(oldLedger.version || (ledCur && ledCur.version) || "").trim();
        }
      }
      if (!spec && !directUrl) {
        const code = catReachable === true ? "not_in_catalog_removed" : "catalog_unreachable";
        throw new Error(code);
      }
    }
    /* 下载地址按**来源**解析（静态目录 = FEED + 相对路径；接口目录 = <store>/api/apps/<id>/file|icon）。
       必须在选版**之前**算：接口目录的 versions[].zipUrl 是静态写法，静态目录里并不存在那个文件。 */
    const urls = spec ? zipUrlsOf(spec) : { zip: "", versions: {} };
    /* 选版下载（§七）：渲染层点了版本树里的某一版 → 只换 zipUrl / sha256 / version，
       其余（entry / window / tags…）仍取应用条目；目录里没有那一版就如实报错。 */
    if (directUrl) {
      if (!wantVersion) throw new Error("bad_version");
      spec = {
        id: id,
        name: "",
        version: wantVersion,
        entry: "",
        description: "",
        icon: "",
        author: "",
        zipUrl: directUrl,
        sha256: directRaw,
        sourceBase: "",
        source: "",
      };
    } else if (wantVersion) {
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
    if (spec.compatible === false) throw new Error("need_app_update");
    const zipUrl = directUrl || resolveZipUrl(spec.zipUrl, specBaseOf(spec));
    if (!zipUrl) throw new Error(installCatalogMiss(spec, catReachable) || "bad_zip_url");
    const exists = fs.existsSync(path.join(root, id));
    let targetId = id;
    if (exists && mode === "rename") targetId = uniqueAppId(root, id);
    else if (exists && mode !== "overwrite" && mode !== "update") {
      const ex = appSummary(root, id, APP_KIND_DOWN);
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
      const sha = sha256(zipBuf);
      const now = Date.now();
      /* 本机多版本台账（§九）：进「当前」槽的这一版记的是**这次真正下下来的地址**（zipUrl 已过
         白名单解析），上一版那一槽接着往下传 —— 但要走一次 app.json 里的旧版本号核对：
         从版本表直接下某一版时，账本里的「当前」还停在上一次装的那版，不核对就会把旧账当上一版。 */
      const oldVer = String((keepMan && keepMan.version) || "").trim();
      const prevSlot = ledgerSlot(isObj(oldLedger.versions) ? oldLedger.versions.cur : null);
      const nextVer = String(man.version || "").trim();
      /* 上一版这一槽怎么定：
         ① 台账的「当前」= 这次要装的版本（同版重装 / 从版本表重下同一版）→ 上一版照旧不动
            （上一版 = 上一版，绝不是自己）；
         ② 换了版：台账当前正对得上 app.json 的旧版本号 → 就用它（含它那次真正的下载地址）；
         ③ 换了版但台账当前对不上（老账本 / 从版本表直接下某一版）→ 记下旧版本号 + 这次用的地址 ——
            地址不一定是最贴切的那一个，但比「没有上一版」强；sha256 留空则不校验，填了就必须对上。 */
      const oldPrev = ledgerSlot(isObj(oldLedger.versions) ? oldLedger.versions.prev : null);
      let keepPrev = oldPrev;
      if (oldVer && oldVer !== nextVer) {
        keepPrev = sameVerSlot(prevSlot, { version: oldVer }) ? prevSlot : verRecord(oldVer, zipUrl, "", 0, 0);
      }
      const curSlot = verRecord(man.version, zipUrl, sha, zipBuf.length, Number(spec.uploadedAt || spec.createdAt || 0));
      /* 账本在原地补字段：老账本里的 lastRunAt（最后一次运行时间，库页排序用）要保住 ——
         整份重写会把它抹掉，用户会看到「刚跑过的应用在列表里排到最后」。 */
      writeJson(installedPath(targetDir), Object.assign({}, oldLedger, {
        schema: SCHEMA,
        id: targetId,
        version: man.version,
        source: zipUrl,
        sha256: sha,
        /* 来源作者（「更新按钮只在同作者时出现」与「分支作者」都靠它判）：
           owner = 云端 username（显示用），ownerId = 云端 uid（判定用，见 docs/apps-market.md §八）。 */
        owner: String(spec.owner || ""),
        ownerId: String(spec.ownerId || ""),
        files: ledger,
        installedAt: now,
        versions: { cur: curSlot || null, prev: keepPrev || null },
      }));
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

/* ── 本机多版本（台账查询 + 回滚；口径见 docs/apps-market.md §九） ──────────────
 * 载荷不落盘：应用目录里只有一份活动副本，回滚 = 按台账里那一版的下载地址 + sha256
 * **重新下载**再换进来。所以源不可达（离线 / 云端已下架那一版）时必须如实报错，
 * 绝不静默降级成「装最新版」。 */

/* 台账（本机装过的那一版从哪来）—— 渲染层据此画「本机版本」块。
   kind（"dev" / "down"，可选）：点名了就看那一套根下的那一份 —— 同 id 在下载根与项目根各有一份时，
   开发页那扇「选择版本…」窗要的是项目根那份的台账（下载副本另有一条账，见 uninstallApp 同一口径）。 */
function appsVersionPick(id, kind) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  /* 台账属于**本机那一边**：调用方点名了类型就用它，否则按该应用实际所在的类型取根
     （没配过就用默认根并固化） */
  const k = kind ? kindOfRoot(kind) : diskKindOf(sid);
  const { root } = ensureRootPersisted(k);
  const dir = appDirOf(root, sid);
  const app = dir && fs.existsSync(dir) ? appSummary(root, sid, k) : null;
  const led = dir ? readInstalled(dir) || {} : {};
  const vers = isObj(led.versions) ? led.versions : null;
  const cur = ledgerSlot(vers && vers.cur);
  const prev = ledgerSlot(vers && vers.prev);
  const curVersion = app ? String(app.version || "") : "";
  const rows = [];
  if (cur) rows.push(Object.assign({ slot: "cur", direct: true, current: true }, cur));
  /* 上一版那一槽只在「真的与本机这一版不同版」时才作为可回滚目标给出 */
  const prevRow = prev && prev.version !== curVersion ? Object.assign({ slot: "prev", direct: false, current: false }, prev) : null;
  if (prevRow) rows.push(prevRow);
  return {
    ok: true,
    id: sid,
    dir: dir || "",
    installed: !!app,
    dev: !!(app && app.dev),
    version: curVersion,
    source: String(led.source || ""),
    sha256: String(led.sha256 || ""),
    installedAt: Number(led.installedAt) || 0,
    versions: rows,
    canRollback: !!prevRow,
    prev: prevRow,
  };
}

/* 回滚：把目标那一版重新下载并换进来。目标版本的地址只认两处（都以本机台账为准）：
 *   ① 台账「上一版」那一槽（记着它那次真正的下载地址）；
 *   ② 本机账本 / 云端目录里同版本号的地址（从版本表点某一版时用）。
 * 都不认识 → gone；地址过不了白名单 → bad_source；重下必过 sha256 校验（对不上即失败）。 */
async function rollbackApp(arg) {
  const a = isObj(arg) ? arg : { id: arg, version: "" };
  const id = safeAppId(a.id);
  if (!id) return bad(t("应用 id 不合法"), "bad_id");
  const target = String(a.version || "").trim();
  if (!target) return bad(t("没有指定要回滚到哪一版"), "bad_version");
  const k = diskKindOf(id);
  const { root } = ensureRootPersisted(k);
  const dir = appDirOf(root, id);
  if (!dir || !fs.existsSync(dir)) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: id });
  const man = readManifest(dir);
  if (!man) return bad(t("应用清单损坏（app.json 读不出来）：先修好它再切换版本"), "broken_manifest");
  const curVer = String(man.version || "").trim();
  if (target === curVer)
    return Object.assign(bad(t("这一版就是本机当前的版本"), "same_version"), { version: curVer, same: true });
  const led = readInstalled(dir) || {};
  const vers = isObj(led.versions) ? led.versions : {};
  const prev = ledgerSlot(vers.prev);
  let hit = sameVerSlot(prev, { version: target }) ? prev : null;
  /* 本机账本只记「当前这一版」：同版本号才算命中（界面点「已装的这一版」走的就是这条） */
  if (!hit && String(led.version || "").trim() === target && String(led.source || "").trim())
    hit = verRecord(target, led.source, led.sha256, led.bytes, 0);
  /* 再退回云端目录里那一版（多版本条目的 versions[]） */
  if (!hit) {
    let spec = null;
    try {
      spec = await findSpec(id);
    } catch (_) {}
    const v = spec && Array.isArray(spec.versions) ? spec.versions.find((x) => String(x.version) === target) : null;
    if (v) {
      const urls = zipUrlsOf(spec);
      hit = verRecord(target, (urls.versions && urls.versions[target]) || v.zipUrl || "", v.sha256, v.bytes, v.createdAt);
    }
  }
  if (!hit || !hit.source)
    return Object.assign(
      bad(t("本机没有这一版的下载来源：它可能是本机自建的那一版，或云端已删除（回滚需要按来源重下）")),
      { gone: true, id: id, version: target },
    );
  /* 台账里的地址一样要过白名单（只认允许基址；绝对地址 host 必须命中）——
     与安装同一条守卫，回滚不是绕过它的后门 */
  const url = resolveZipUrl(hit.source, specBaseOf({ sourceBase: "", source: "" }));
  if (!url) return bad(t("这一版的下载地址不在允许的来源里（只认云端目录 / 云端接口）"), "bad_source");
  return installApp({
    id: id,
    mode: "overwrite",
    version: target,
    directUrl: url,
    directSha: hit.sha256 || "",
    rollback: true,
  });
}

/* 删除该应用（**按类型分两种语义**，用户口径：删一个绝不误删另一个）：
 *   · 下载的（kind="down"）：真删 —— 只删它自己在**下载根**下的子文件夹
 *     （守卫：必须严格等于 <下载根>/<id>；优先送系统回收站）+ 它自己那一棵数据
 *     <数据目录>/apps-data/downloaded/<id>/（且只在「就是默认那一棵」时才删，
 *     用户自己选过的数据文件夹一律不动）；**绝不碰项目根、绝不碰 apps-data/dev/**。
 *   · 开发的（kind="dev"）：**只移除登记**（unregisterApp）—— 源码就在项目根里，
 *     删目录等于删用户的工程；要删文件由用户在资源管理器里自己删。
 * opts = { force: "dev_remove" } —— 开发中的应用必须显式带这个标记，
 * 免得调用方拿老签名误删自己的工程。 */
async function uninstallApp(id, opts) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  /* 类型：**调用方点名了就用它**（开发页点「卸载」时传 dev，同 id 在下载根也有一份时
     只有它分得清要摘的是哪一份），没点名仍按本机实际所在的那一边（老口径）。 */
  const o = isObj(opts) ? opts : {};
  const k = o.kind ? kindOfRoot(o.kind) : diskKindOf(sid);
  if (k === APP_KIND_DEV) return unregisterApp(sid, opts);
  const { root } = ensureRootPersisted(APP_KIND_DOWN);
  const dir = appDirOf(root, sid);
  if (!dir) return bad(t("非法路径"), "bad_id");
  if (!fs.existsSync(dir)) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: sid });
  /* 类型核对：文件说它是**开发中的应用**却躺在下载根里（老布局 / 用户手放）也走「移除登记」 */
  if (kindOfManifest(rawManifestOf(dir), dir) === APP_KIND_DEV) return unregisterApp(sid, opts);
  closeAppWindow(sid);
  writeModelSelection(sid, MODEL_AUTO); /* 删除顺手清掉该应用的模型选择（不留孤儿条目） */
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
  /* 它自己那一棵数据：只删 downloaded 这一棵（dev 那棵一个字节都不动） */
  const dataRootAbs = (() => {
    try {
      return appDataRootPath(sid, APP_KIND_DOWN);
    } catch (_) {
      return "";
    }
  })();
  const dataDir = (() => {
    const p = readDataDirPointer(sid, APP_KIND_DOWN);
    return p && p.dir && path.isAbsolute(p.dir) ? p.dir : dataRootAbs;
  })();
  let dataRemoved = false;
  if (dataDir && dataRootAbs && cmpPath(dataDir) === cmpPath(dataRootAbs) && fs.existsSync(dataDir)) {
    try {
      await shell.trashItem(dataDir);
      dataRemoved = true;
    } catch {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        dataRemoved = true;
      } catch {}
    }
  }
  return {
    ok: true,
    id: sid,
    kind: APP_KIND_DOWN,
    mode: "uninstall",
    dir: dir,
    trashed: trashed,
    root: root,
    dataDir: dataDir,
    dataRemoved: dataRemoved,
    dataKept: !!dataDir && !dataRemoved,
  };
}

/* 「移除登记」= 开发中的应用唯一的移除方式：只摘掉应用中心里的登记（app.json 的 dev → false
 * + removed:true），**磁盘上的项目文件夹一个字节都不动**（源码 / 画布镜像 / 数据目录全保留）。 */
async function unregisterApp(id, opts) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const o = isObj(opts) ? opts : {};
  if (o.force !== "dev_remove")
    return bad(t("开发中的应用不能卸载（源码就在项目文件夹里）：只能「移除登记」"), "dev_keep_files");
  /* 目录：**按调用方点名的类型取**（开发页传 dev），没点名才两套根都看一眼 */
  const dir = dirOfApp(sid, o.kind ? kindOfRoot(o.kind) : "");
  if (!dir || !fs.existsSync(dir)) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: sid });
  const raw = readManifest(dir);
  if (!raw) return bad(t("应用清单损坏（app.json 读不出来）：先修好它再移除登记"), "broken_manifest");
  closeAppWindow(sid);
  writeModelSelection(sid, MODEL_AUTO);
  try {
    writeJson(manifestPath(dir), Object.assign({}, raw, { dev: false, removed: true, removedAt: Date.now() }));
  } catch (err) {
    return fail(err);
  }
  return {
    ok: true,
    id: sid,
    kind: APP_KIND_DEV,
    mode: "unregister",
    dir: dir,
    filesKept: true,
    removed: true,
    note: t("只移除了登记：项目文件夹与其中的文件全部原样保留（要删文件请在资源管理器里自己删）"),
  };
}

/* ---------------- 旧布局显式迁移（下载的与开发的分开） ----------------
 *
 * 用户口径（本次需求）：
 *   · 下载的应用与开发的应用要**严格分开**：目录、数据、删除范围三样都分；
 *   · 但**绝不自动搬用户的盘** —— 只给显式入口，先 dry-run 列出会动哪些目录，用户点了才动。
 *
 * 迁移动作（只搬两类东西，业务文件一律不动）：
 *   A. 应用目录：下载根里那些 app.json 写着 dev:true 的目录 → 项目根（<devRoot>/<id>）。
 *      项目根与下载根配成同一个目录时什么都不用搬（里面本来就各就各位）。
 *   B. 数据目录：<数据目录>/apps-data/<id>/ → apps-data/<dev|downloaded>/<id>/
 *      （按该应用的类型；目标已存在则跳过并如实报出，绝不覆盖）。
 *
 * 冲突处理：目标目录已存在 → 跳过（conflicts 里给出原因），绝不覆盖、绝不合并半份。
 * 返回 { ok, dryRun, devRoot, downRoot, moves:[{kind, what, from, to, action, reason}], ... }。 */
function migrateAppsLayout(arg) {
  const a = isObj(arg) ? arg : {};
  const dryRun = a.dryRun !== false; /* 缺省 = 只看不动（安全默认） */
  /* 只搬一个应用（「二次开发」刚把某个下载的应用改成开发中时用它就地归位）；
     不给 id 就是全量迁移。 */
  const onlyId = safeAppId(a.id);
  /* 搬家要用到两个根：**真搬的时候**（非 dryRun）没配过就固化默认根 —— 本轮口径：不再要求
     用户手选（见 ensureRootPersisted）。dryRun 是「只看不动」，一行配置都不写。 */
  if (!dryRun) {
    ensureRootPersisted(APP_KIND_DOWN);
    ensureRootPersisted(APP_KIND_DEV);
  }
  const roots = rootsInfo();
  const downRoot = String((roots[APP_KIND_DOWN] || {}).path || "");
  const devRoot = String((roots[APP_KIND_DEV] || {}).path || "");
  const sameRoot = !!downRoot && cmpPath(downRoot) === cmpPath(devRoot);
  const moves = [];
  const conflicts = [];
  const skipped = [];
  const note = [];

  /* ---- A. 应用目录 ---- */
  if (sameRoot) {
    note.push(t("两套根当前指向同一个目录：应用目录无需搬动（每条应用按自己的 dev 标记归位）"));
  } else if (!downRoot || !fs.existsSync(downRoot)) {
    note.push(t("下载根目录不存在，没有需要搬动的应用"));
  } else {
    let ents = [];
    try {
      ents = fs.readdirSync(downRoot, { withFileTypes: true });
    } catch (_) {
      ents = [];
    }
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const id = safeAppId(ent.name);
      if (!id) continue;
      if (onlyId && id !== onlyId) continue;
      const from = path.join(downRoot, ent.name);
      const raw = rawManifestOf(from);
      if (!raw) continue;
      if (kindOfManifest(raw, from) !== APP_KIND_DEV) continue;
      const to = appDirOf(devRoot, id);
      if (!to) continue;
      if (cmpPath(from) === cmpPath(to)) continue;
      if (fs.existsSync(to)) {
        conflicts.push({
          kind: "app",
          id: id,
          from: from,
          to: to,
          reason: t("目标目录已存在（同一个 id 在项目根里已有一份）：不覆盖，请自己核对后手动处理"),
        });
        continue;
      }
      moves.push({ kind: "app", id: id, from: from, to: to, action: "move", reason: t("开发中的应用搬进项目根") });
    }
  }

  /* ---- B. 数据目录 ---- */
  const dataRoot = path.join(String(getDataDir() || ""), DATA_ROOT_DIR);
  let dataEnts = [];
  try {
    dataEnts = fs.existsSync(dataRoot) ? fs.readdirSync(dataRoot, { withFileTypes: true }) : [];
  } catch (_) {
    dataEnts = [];
  }
  const kindById = new Map();
  for (const app of listApps().apps || []) {
    const sid = String(app.id);
    /* 归位按 **app.json 的 dev 标记**（唯一真源，与上面「开发中的应用搬进项目根」同源）：
       listApps 的 kind 是「哪一套根扫到它」，对旧布局里还没搬家的开发应用（清单 dev:true、
       却还躺在下载根）会算成 down —— 它的老数据该归 apps-data/dev/<id>，所以这里看清单的 dev 位
       （app.dev 已被「根即身份」覆盖过，不能当清单真源用）。同一个 id 两边各有一份时开发优先。 */
    let manDev = false;
    try {
      const d = dirOfApp(sid, app.kind);
      const raw = d ? rawManifestOf(d) : null;
      manDev = !!raw && raw.dev === true;
    } catch (_) {
      manDev = false;
    }
    const k = manDev ? APP_KIND_DEV : app.kind;
    if (k === APP_KIND_DEV || !kindById.has(sid)) kindById.set(sid, k);
  }
  for (const ent of dataEnts) {
    if (!ent.isDirectory()) continue;
    const id = safeAppId(ent.name);
    if (!id) continue; /* dev / downloaded 这两棵自己会被跳过（不是合法 app id 的除外） */
    if (onlyId && id !== onlyId) continue;
    const from = path.join(dataRoot, ent.name);
    /* 数据归位：老数据目录（apps-data/<id>/）是升级前的样子，它属于谁看 app.json 的 dev 标记
       （**唯一真源**，与「开发中的应用搬进项目根」那条同源）—— 不按「哪一套根扫到它」判，
       否则旧布局里一个还没搬家的开发应用，数据会被错归到 downloaded 那棵。 */
    const k = kindById.get(id) || kindOfManifest(rawManifestOf(dirOfApp(id)), dirOfApp(id));
    const to = path.join(dataRoot, DATA_SUB[k], id);
    if (cmpPath(from) === cmpPath(to)) continue;
    if (fs.existsSync(to)) {
      conflicts.push({
        kind: "data",
        id: id,
        from: from,
        to: to,
        reason: t("目标数据目录已存在：不覆盖（两边都留着，请自己核对后手动合并）"),
      });
      continue;
    }
    moves.push({
      kind: "data",
      id: id,
      from: from,
      to: to,
      action: "move",
      reason: k === APP_KIND_DEV ? t("开发应用的数据搬进 apps-data/dev") : t("下载应用的数据搬进 apps-data/downloaded"),
    });
  }
  /* dev / downloaded 这两棵容器目录本身不参与搬动（它们就是目的地） */
  for (const dir of [DATA_SUB.dev, DATA_SUB.down]) {
    const i = moves.findIndex((m) => m.kind === "data" && cmpPath(m.from) === cmpPath(path.join(dataRoot, dir)));
    if (i >= 0) moves.splice(i, 1);
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      only: onlyId || "",
      downRoot: downRoot,
      devRoot: devRoot,
      sameRoot: sameRoot,
      moves: moves,
      conflicts: conflicts,
      skipped: skipped,
      note: note,
      at: Date.now(),
    };
  }

  /* ---- 真搬（逐个，失败的记进 skipped，绝不半途而废地覆盖任何东西） ---- */
  let moved = 0;
  for (const m of moves) {
    try {
      mk(path.dirname(m.to));
      fs.renameSync(m.from, m.to);
      moved++;
    } catch (err) {
      /* 跨盘 / 被占用 → 退回「复制后删源」；复制失败就整条跳过，源目录原样留着 */
      try {
        copyDirRecursive(m.from, m.to);
        rmDirRecursive(m.from);
        moved++;
      } catch (err2) {
        skipped.push({
          kind: m.kind,
          id: m.id,
          from: m.from,
          to: m.to,
          error: String((err2 && err2.message) || err2 || (err && err.message) || err),
        });
      }
    }
  }
  return {
    ok: true,
    dryRun: false,
    only: onlyId || "",
    downRoot: downRoot,
    devRoot: devRoot,
    sameRoot: sameRoot,
    moved: moved,
    moves: moves,
    conflicts: conflicts,
    skipped: skipped,
    note: note,
    at: Date.now(),
  };
}

/* ---------------- 导出 zip（应用目录里的应用文件全部随包，不含画布 / 本机态） ---------------- *
 *
 * 打包范围：**整目录**（子目录递归）—— 应用怎么写都行（根目录多份 js / css、lib/、media/…）。
 * 排除分两半（见 packExcludedFiles）：
 *   ① **应用目录里的中途产物**（开发期才存在的那些东西 / 本机生成物，见 APP_PACK_EXCLUDE 段，
 *      上架包与本机导出 zip **同一套规则**）；
 *   ② **app 自己的本机存档**（storage/，只有 opts.forUpload = true = 上架包才剔）。
 * 包里那份 app.json 去掉本机的「开发中」标记 dev（本机状态，跟包跑出去会让下载者把这个
 * 应用当成「正在开发」而不列进「库」）；author 与 forkOf 照常随包走 —— 契约见 docs/apps-market.md §八。
 * 回执带 excluded / excludedCount（排除清单与条数，封顶 APP_PACK_EXCLUDE_REPORT_MAX），
 * 上架窗据此显示「已排除 N 个开发文件」—— 作者能自己核对，不必猜文件为什么没上去。
 *
 * 调用方（本轮需求后）：**上架不再调它** —— 上架链路只走 readPackBase64（一趟 = 上架口径 +
 * base64 + sha256）。本函数仍是打包唯一实现（readPackBase64 与冒烟直接调它），并保留
 * 默认口径（保留 storage/）=「本机导出 zip」那一套语义，只是那条界面入口早已下线。 */

/* ── 打包排除规则（本轮需求：应用开发过程中在应用目录里产生的中途内容与数据，
      不再随包（上架包 + 本机导出 zip 同一套）发给别人）─────────────────────────────
 *
 * 现场（真机开发根实测，`<apps.projectDir>/<id>`）：AI 开发会话把工作区就设成应用目录，
 * 于是 AGENTS.md / DELIVERY.md、dev-server.mjs / dev-verify.mjs / smoke-out.txt、*.orig 备份、
 * tools/*.cjs 探针与截图、.mtnode-input/ 粘贴图、改了名的第二份 *.mtnodes、storage/.dbg-profile/
 * （整套 Edge 调试 profile）都躺在应用目录里；旧实现是**整目录打包**，它们全都随上架包上去了。
 *
 * 口径（用户共识，逐条对应）：
 *   · 只做**打包过滤**，开发目录一个文件都不动（不删、不移、不新增目录约定）；
 *   · 规则是**代码里的固定表**（就是下面这几行），没有配置文件、没有逐项勾选；
 *   · 只排**应用根目录那一层**的脚本与残留 —— 子目录一律豁免，避免误伤 assets/ 下的
 *     运行期数据（如 assets/gen/manifest.js 是 sprite.js 要读的名单、assets/fonts/OFL.txt
 *     是随包许可文件）；**不排 tools/ 整目录**（assets/tools 之类可能被运行期读）；
 *   · **不排任意 *.md**：只排下面那几个开发笔记名；应用写给用户的 README.md 照旧随包；
 *   · *.mtnodes 排**任意层级**（第二份 / 改了名的画布同样是开发期产物：里面有 devPath 绝对
 *     路径、会话 id 与开发笔记）；storage/.dbg-profile/ 排**任意层级**（Edge 调试 profile）；
 *   · storage/ 其余内容保留（数据表 / 构建脚本 / 存档照常随包，作者换机拿到的是完整工程）。
 *
 * 入口页优先：万一某条规则碰到 app.json 声明的入口页，**保留它**并在 warnings 里报一句 ——
 * 包缺入口页会整包打不出来（服务端校验会拒），这比多带一个文件严重得多。 */
const APP_PACK_EXCLUDE = {
  /* 任意层级：后缀（小写比较） */
  extAny: [".mtnodes", ".orig", ".bak", ".tmp", ".log"],
  /* 任意层级：相对路径前缀（目录） */
  dirAny: [".mtnode-input/"],
  /* 任意层级：路径里出现任一段即排（调试 / 中转目录） */
  segAny: [SUB.staging, ".dbg-profile"],
  /* 仅应用根目录那一层：精确文件名（小写比较） */
  rootNames: ["agents.md", "delivery.md", "product.md", "notes.md", "todo.md"],
  /* 仅应用根目录那一层：通配（* = 除 "/" 外任意串；匹配小写化后的名字） */
  rootGlobs: [
    "dev-*.js",
    "dev-*.mjs",
    "dev-*.cjs",
    "verify-*.mjs",
    "*-audit.*",
    "smoke*.*",
    "*-probe.*",
    "*-notes.md",
    "*-out.txt",
    "longtask-*.json",
  ],
  /* 仅在 storage/ 之下：通配（Windows 下 storage 名大小写不敏感，命中判断先小写化） */
  storageGlobs: ["probe-*.txt"],
  /* 上架包另剔：app 自己的本机存档（本地导出 zip 保留 —— 换机搬家连存档一起走） */
  uploadOnlyDirs: [SUB.storage],
};
/* excluded 清单回执的条数上限：上架是 IPC 传 JSON，几百条路径会把回执撑大；
   条数另给 excludedCount（永远是真值），界面上写清「只列前 N 条」。 */
const APP_PACK_EXCLUDE_REPORT_MAX = 200;

/* 应用根目录那一层的通配匹配（整串匹配，大小写不敏感；只吃单段名字，不含 "/"） */
function packNameGlobHit(name, glob) {
  const g = String(glob || "").toLowerCase();
  if (!g) return false;
  const rx = g.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp("^" + rx + "$").test(String(name || "").toLowerCase());
}
/* 名字只在 storage/ 之下才判的通配（同上，只是作用域不同；storage 段大小写不敏感） */
function packStorageGlobHit(rel, name) {
  return APP_PACK_EXCLUDE.storageGlobs.some((g) => {
    if (!packNameGlobHit(name, g)) return false;
    const parts = rel.split("/");
    return parts.length >= 2 && String(parts[0] || "").toLowerCase() === SUB.storage;
  });
}
/* 这一条相对路径是不是「打包不该带的中途产物」（相对应用目录，"/" 分隔）。
   o.forUpload = true 时另剔 app 自己的本机存档（storage/）。 */
function packExcludedRel(rel, opts) {
  const r = String(rel == null ? "" : rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!r) return false;
  const o = isObj(opts) ? opts : {};
  const lower = r.toLowerCase();
  const slash = r.lastIndexOf("/");
  const inRoot = slash < 0;
  const name = inRoot ? r : r.slice(slash + 1);
  const nameLower = name.toLowerCase();
  const segs = r.split("/").map((x) => x.toLowerCase());
  /* 上架包另剔：app 自己的本机存档（见 uploadOnlyDirs） */
  if (o.forUpload === true) {
    for (const d of APP_PACK_EXCLUDE.uploadOnlyDirs) {
      const dl = String(d).toLowerCase();
      if (lower === dl || lower.indexOf(dl + "/") === 0) return true;
    }
  }
  for (const d of APP_PACK_EXCLUDE.dirAny) if (lower.indexOf(String(d).toLowerCase()) === 0) return true;
  /* 路径里出现任一段即排（Windows 下 storage / .staging 等大小写不敏感，比较先小写化） */
  for (const d of APP_PACK_EXCLUDE.segAny) if (segs.indexOf(String(d).toLowerCase()) >= 0) return true;
  for (const e of APP_PACK_EXCLUDE.extAny) if (nameLower.endsWith(e)) return true;
  if (inRoot) {
    if (APP_PACK_EXCLUDE.rootNames.indexOf(nameLower) >= 0) return true;
    if (APP_PACK_EXCLUDE.rootGlobs.some((g) => packNameGlobHit(name, g))) return true;
  }
  if (packStorageGlobHit(r, name)) return true;
  return false;
}
/* 本机自己生成 / 与包无关的文件：打包一律不带它们（名字口径跟着清单走：画布与导出包分别是
   <AppName>.mtnodes / <AppName>.zip）。**app.json 不在这里**：包里那份是 packEntriesOf
   现读现写的（去掉 dev 标记），列进来会让包缺清单（下载方认不出应用）。
   尾参 opts.excludeExtra 是「打包口径」的显式注入点：正常路径不传；冒烟用它模拟
   「打包实现漏了一类应用文件」，验证包内清单真的少那一条（而不是只看自己那份名单）。 */
function packExcludedFiles(dir, man, opts) {
  const name = safeBaseName((man && man.name) || path.basename(dir), "app");
  const out = [SUB.installed, name + CANVAS_EXT, name + ZIP_EXT];
  const extra = isObj(opts) && Array.isArray(opts.excludeExtra) ? opts.excludeExtra : [];
  for (const rel of extra) out.push(String(rel || ""));
  return out.filter((v, i) => v && out.indexOf(v) === i);
}
/* 应用目录 → 包里的文件清单（顺序稳定：按相对路径字典序；唯一读取实现，导出与上架包共用）。
   回 [{ name, data }] + excluded（被排除的中途产物，见 APP_PACK_EXCLUDE）+ excludedCount。 */
function packEntriesOf(dir, sid, opts) {
  const o = isObj(opts) ? opts : {};
  const man = manifestOf(dir, sid);
  const entry = safeEntry(man.entry) || SUB.index;
  const skip = packExcludedFiles(dir, man, o);
  const excluded = [];
  const warnings = [];
  /* 中途产物（规则表）命中即排；命中入口页则**保留**（宁可不排，也不让包因为缺入口页整包打不出来） */
  const devLeftover = (rel) => {
    if (!packExcludedRel(rel, o)) return false;
    if (rel === entry) {
      warnings.push(t("这个文件看起来是开发期产物，但它是 app.json 声明的入口页，已保留：") + rel);
      return false;
    }
    excluded.push(rel);
    return true;
  };
  const files = walkFiles(dir, "", [])
    .filter((rel) => {
      /* excludeExtra 是显式注入点：它说了就排（连入口页也不豁免）—— 冒烟靠它验「真少了一条」 */
      if (skip.indexOf(rel) >= 0) return false;
      if (devLeftover(rel)) return false;
      return true;
    })
    .sort();
  const entries = [];
  for (const rel of files) {
    const abs = resolveInside(dir, rel);
    if (!abs || !fs.existsSync(abs)) continue;
    let data = null;
    if (rel === SUB.manifest) {
      const packMan = Object.assign({}, readManifest(dir) || {});
      delete packMan.dev;
      data = Buffer.from(JSON.stringify(packMan, null, 2), "utf8");
    } else {
      data = fs.readFileSync(abs);
    }
    entries.push({ name: rel, data: data });
  }
  if (!entries.some((e) => e.name === entry)) return { ok: false, error: t("应用缺少入口页"), reason: "missing_entry" };
  /* 排除清单按相对路径字典序（与包内清单同序，界面上读起来稳），条数封顶、另给真值计数 */
  excluded.sort();
  return {
    ok: true,
    entries: entries,
    man: man,
    entry: entry,
    excluded: excluded.slice(0, APP_PACK_EXCLUDE_REPORT_MAX),
    excludedCount: excluded.length,
    warnings: warnings,
  };
}

function exportZip(id, opts) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const dir = dirOfApp(sid);
  if (!dir || !fs.existsSync(dir)) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: sid });
  try {
    const built = packEntriesOf(dir, sid, opts);
    if (built.ok === false) return bad(built.error, built.reason);
    const man = built.man;
    const entries = built.entries;
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
      /* 被排除的中途产物（开发期产物 / 本机生成物，见 APP_PACK_EXCLUDE）：
         上架窗拿它显示「已排除 N 个开发文件」并可展开清单（本条需求 · 可核对）。 */
      excluded: built.excluded || [],
      excludedCount: Number(built.excludedCount) || 0,
      warnings: built.warnings || [],
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

/* 上架用：**现打一份** zip 再读回 base64（与 exportZip 同一份打包实现：应用目录里的应用文件
   全部随包，不含画布、本机存档与开发期产物）。现打现读 = 绝不会把上一轮导出的旧包传上去。
   回执把 exportZip 的排除清单（excluded / excludedCount）原样带出来 —— 与 zip 同一趟打包算的，
   不会出现「界面说排了 5 个、实际排了 7 个」。
   **这是上架链路的唯一一趟打包**（本轮需求）：同一次调用既给要上传的 base64，也给这份字节的
   sha256 —— 两者出自同一份 buffer，天生自洽，不存在「两趟包 sha 对不上」的失败模式
   （旧实现先 exportZip 打一份默认口径的包、再在这里打一份上架口径的包，两趟文件集必然不同）。 */
function readPackBase64(id) {
  const r = exportZip(id, { forUpload: true });
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
      excluded: r.excluded || [],
      excludedCount: Number(r.excludedCount) || 0,
      warnings: r.warnings || [],
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
  /* 两套根各自快照（下载的 + 开发的），合并成一份按 id 的变更表 */
  const roots = rootsInfo();
  const root = String((roots[APP_KIND_DOWN] || {}).path || "");
  const configured =
    !!(roots[APP_KIND_DOWN] || {}).configured || !!(roots[APP_KIND_DEV] || {}).configured;
  const prev = readJson(snapshotPath(), null);
  const next = (() => {
    const merged = { at: Date.now(), root: root, apps: Object.create(null) };
    for (const k of APP_KINDS) {
      const r = String((roots[k] || {}).path || "");
      if (!r) continue;
      const snap = snapshotOf(r);
      for (const id of Object.keys(snap.apps)) merged.apps[id] = snap.apps[id];
    }
    return merged;
  })();
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
function previewDirOf(id, kind) {
  const sid = safeAppId(id);
  if (!sid) return "";
  /* 两套根都找：开发的应用在项目根、下载的在下载根（大小写不敏感，URL 的 host 会被规范化）。
     kind 给了就看**那一套根**（缺省按 listApps 的口径，见下）。 */
  const want = kind ? kindOfRoot(kind) : "";
  if (want) {
    const d = dirOfApp(sid, want);
    if (d && fs.existsSync(d)) return d;
  }
  /* **按 listApps 的回执取**（不是重新按目录猜）：同一个 id 在下载根与项目根各有一份时
     （用户在「选择版本…」里看对方那一版时装了一份同 id 的进下载根），老写法先扫下载根 =
     开发页预览的一直是**下载副本**、代码改完预览纹丝不动 —— 与「开发会话里项目不对」
     同一根源。listApps 已按根去重且每条带 kind，取第一条就是「下载优先」的稳定口径。 */
  let list = null;
  try {
    list = listApps();
  } catch (_) {
    list = null;
  }
  const hit = list && Array.isArray(list.apps) ? list.apps.find((a) => a && a.id === sid) : null;
  if (hit && hit.dir && fs.existsSync(hit.dir)) return String(hit.dir);
  /* 回执里没有（列表读不动 / 目录刚被搬走）：退回老口径 —— 两套根顺序找一遍。 */
  for (const k of APP_KINDS) {
    let root = "";
    try {
      root = rootPathOf(k).root;
    } catch (_) {
      continue;
    }
    if (!root || !fs.existsSync(root)) continue;
    const direct = appDirOf(root, sid);
    if (direct && fs.existsSync(direct)) return direct;
    let ents = [];
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const hit = ents.find((e) => e.isDirectory() && e.name.toLowerCase() === sid.toLowerCase());
    const dir = hit ? path.join(root, hit.name) : "";
    if (dir && fs.existsSync(dir)) return dir;
  }
  return "";
}
/* 开发页一次拿齐：iframe 预览 url + 内容快照（文件数 / 字节 / 最新 mtime，口径同 appSummary）。
   开发页每轮开发结束后调它，快照没变就不重载预览。 */
function devPreview(id) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  /* 根目录永远有（没配过就是默认根，见 ensureRootPersisted）：这里不再有「尚未指定项目根」
     这条拦人分支 —— 本轮口径是不再要求用户手选；真不在本机由 previewDirOf 回 missing。 */
  ensureRootPersisted(APP_KIND_DEV);
  /* **项目根那一份**（不是按 id 猜的那一份）：同 id 在下载根也有时，开发页要的是用户在改的这一份 */
  const dir = previewDirOf(sid, APP_KIND_DEV);
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
  /* 关窗前先把「合并窗里还没落盘的那一发」落到盘上：数据落盘是异步合并的，
     窗口一关（甚至 MTNode 一起退）压着的那一份就没了 —— 应用看到的「最后一步没保存」
     就是这么来的。落盘是同步的，这里当场就完事。 */
  dataWriteFlushApp(sid);
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
/* 等应用窗口真退干净（完全替换要删它整个应用目录，文件被占就删不掉）：
   关闭链路本身有上限（WILL_CLOSE_MS，应用回过包 / 超时都会走 close()），这里再等一小段。
   返回 true = 已经不在了；false = 到点还在（调用方据此中止替换，什么都不动）。 */
const REPLACE_CLOSE_WAIT_MS = 3000;
function waitAppWindowClosed(id) {
  const sid = String(id || "");
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (!isAppWindowOpen(sid)) return resolve(true);
      if (Date.now() - started >= REPLACE_CLOSE_WAIT_MS) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}
function notifyWindowChanged(id, open) {
  try {
    const mw = getMainWin && getMainWin();
    if (mw && !mw.isDestroyed()) mw.webContents.send("apps:windowChanged", { id: String(id || ""), open: !!open });
  } catch {}
}

/* ---------------- 预览态宿主桥（开发页中栏 iframe 也能连入 MTNode） ----------------
 *
 * 为什么有这一段：开发页中栏的实时预览是 renderer 里的一只 iframe（url = mtnode-preview://…），
 * **没有 preload**，所以页面里 window.appHost 是 undefined —— 应用只能退回 localStorage，
 * 并在界面上弹「未接入 MTNode 数据桥」。用户口径（本轮共识）：预览里也要连入 MTNode，
 * 能力与独立窗口一致。
 *
 * 机制（三层，不改任何既有白名单）：
 *   ① 预览协议给 HTML 多注入一段「宿主桥小助手」（PREVIEW_BRIDGE）：它在 iframe 里
 *      拼出 **与 preload-app.js 同形状**的 window.appHost（薄壳，全部走 postMessage）；
 *   ② 开发页（renderer/app-apps-dev.js）当**中继**：按来源帧校验 → 调主窗口 preload 上
 *      新开的那一组 apps:previewHost* 通道；
 *   ③ 主进程这一层：**复用与独立窗口完全相同的宿主函数**，只换「认应用」的方式 ——
 *      独立窗口按发送方窗口认（wcToAppId），预览按**租约**认（appId + 每帧一枚 token，
 *      由主窗口登记，见 registerPreviewLease）。
 *
 * 纪律（都不许放宽）：
 *   · 只有主窗口（MTNode 自己的 renderer）能登记租约：应用窗口 / 别处一律拒（not_main）；
 *   · 租约只认**本机真实存在的应用目录**，且同时只允许一条（登记新的 = 上一帧作废）；
 *   · 预览里 close() / quit() 一律禁用（没有「自己的窗口」可关）：回 preview_no_window；
 *   · 应用已在独立窗口开着时，预览**只读**（拒绝一切写：数据 / 存储 / 模型与图像后端选择 /
 *     出图与图像编辑），回 readonly_preview —— 两处同时写同一份存档会互相覆盖；
 *   · 其余能力（读、文本生成、转写、账号、选图）与独立窗口逐字同一条实现。 */
const previewLeases = { active: null, byToken: new Map() };
/* 登记的租约是不是属于这个发送方（主窗口校验）：认 webContents 本身 */
function previewLeaseOf(e, token) {
  const l = previewLeases.byToken.get(String(token || ""));
  if (!l || !e || !e.sender) return null;
  try {
    const mw = getMainWin && getMainWin();
    if (!mw || mw.isDestroyed() || mw.webContents !== e.sender) return null;
  } catch {
    return null;
  }
  return l;
}
function previewAppIdOf(e, arg) {
  const a = isObj(arg) ? arg : {};
  const l = previewLeaseOf(e, a.token);
  return l ? String(l.id || "") : "";
}
/* 拒绝文案与错误码（应用侧据此区分「预览只读」与其他失败；渲染层据此在预览区浮提示） */
function previewReadOnlyError() {
  return Object.assign(bad(t("该应用已在独立窗口运行，预览为只读"), "readonly_preview"), {
    previewReadOnly: true,
  });
}
function previewNoWindowError() {
  return Object.assign(bad(t("预览里没有可关闭的独立窗口（预览是开发页中栏的一只 iframe）"), "preview_no_window"), {
    preview: true,
  });
}
/* 写类调用进门前先过这一关：预览 + 独立窗口开着 = 拒（回结构化错误码 + 在预览区浮一条提示）。
   返回 null = 放行（独立窗口的调用 / 预览但不处于只读）。 */
function previewWriteBlock(e, arg) {
  const id = previewAppIdOf(e, arg);
  if (!id || !isAppWindowOpen(id)) return null;
  emitPreviewNotice(id, "readonly_preview", t("该应用已在独立窗口运行，预览为只读"));
  return previewReadOnlyError();
}
/* 预览里被禁 / 被拒的调用：让开发页能在预览区浮一条短提示（事件挂在主窗口的 dsh:event 通道上，
   与流式事件同一条 → 渲染层一处订阅就够） */
function emitPreviewNotice(appId, code, error) {
  try {
    const mw = getMainWin && getMainWin();
    if (!mw || mw.isDestroyed()) return;
    mw.webContents.send("dsh:event", {
      type: "preview-notice",
      appId: String(appId || ""),
      code: String(code || ""),
      error: String(error || ""),
    });
  } catch {}
}
/* 登记一条预览租约（dev page 调；旧帧作废）。id 必须是本机真实存在的应用目录 */
function registerPreviewLease(e, arg) {
  const a = isObj(arg) ? arg : {};
  const sid = safeAppId(a.appId);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  let mw = null;
  try {
    mw = getMainWin && getMainWin();
  } catch {}
  if (!mw || mw.isDestroyed() || !e || e.sender !== mw.webContents)
    return bad(t("只有主窗口能登记预览会话"), "not_main");
  const dir = previewDirOf(sid);
  if (!dir) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: sid });
  const token = String(a.token || "").slice(0, 64);
  if (!token) return bad(t("缺少预览会话标识"), "bad_token");
  if (previewLeases.active) previewLeases.byToken.delete(previewLeases.active.token);
  const lease = { id: sid, token: token, at: Date.now() };
  previewLeases.active = lease;
  previewLeases.byToken.set(token, lease);
  return { ok: true, id: sid, token: token, readOnly: isAppWindowOpen(sid), dir: dir };
}
/* 撤掉租约（切应用 / 关页 / iframe 换页时调）。不带 token = 撤当前那条 */
function releasePreviewLease(e, arg) {
  const a = isObj(arg) ? arg : {};
  const token = String(a.token || "");
  let mw = null;
  try {
    mw = getMainWin && getMainWin();
  } catch {}
  if (!mw || mw.isDestroyed() || !e || e.sender !== mw.webContents) return bad(t("不是主窗口"), "not_main");
  if (token) {
    const l = previewLeases.byToken.get(token);
    if (l) {
      previewLeases.byToken.delete(token);
      if (previewLeases.active === l) previewLeases.active = null;
    }
    return { ok: true, id: l ? l.id : "", released: !!l };
  }
  if (previewLeases.active) previewLeases.byToken.delete(previewLeases.active.token);
  previewLeases.active = null;
  return { ok: true, released: true };
}
/* 预览租约的现况（开发页状态行 / 只读实时化用；不需要租约也能问，只回计数与开关） */
function previewLeaseState() {
  const l = previewLeases.active;
  return {
    ok: true,
    id: l ? l.id : "",
    active: !!l,
    readOnly: !!(l && isAppWindowOpen(l.id)),
  };
}
/* 预览态的流式事件（文本 / 图像进度 / 语音状态）：e.sender 是**主窗口**（预览中继在渲染层），
   所以事件要发给主窗口；带 appId —— 开发页按它把事件转给中栏那一帧（同机可能开着多个应用）。 */
function emitHostStreamFor(e, arg, payload) {
  const msg = Object.assign({ appId: previewAppIdOf(e, arg) }, payload || {});
  /* 独立窗口那条路逐字不变：谁调的发给谁（app 窗口或主窗口都一样是 e.sender） */
  try {
    if (e && e.sender && !e.sender.isDestroyed()) e.sender.send("apps:hostStream", msg);
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
   will-navigate 一律 preventDefault（外链交 shell.openExternal）· 新窗口一律 deny。
   kind（"dev" / "down"，可选）＝**开哪一套根下的那一份**：同 id 两边各有一份时，
   开发页点「启动 / 打开」要的是项目根那份（源码在改的那份），不能按 id 猜。 */
function openAppWindow(id, kind) {
  const sid = safeAppId(id);
  if (!sid) return bad(t("应用 id 不合法"), "bad_id");
  const existing = appWins.get(sid);
  if (existing && !existing.isDestroyed()) {
    try {
      existing.show();
      existing.focus();
    } catch {}
    noteAppRun(sid); /* 把窗口调到前台也算「用了一次」（库页按最近运行排序） */
    notifyWindowChanged(sid, true);
    return { ok: true, id: sid, open: true, reused: true };
  }
  /* 应用可能在哪一边（下载根 / 项目根）：点名了类型就取那一边，否则按本机实际所在的那一类取 */
  const dir = dirOfApp(sid, kind ? kindOfRoot(kind) : "");
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
    dataWriteFlushApp(sid); /* 兜底：任何路径关掉的窗口，压着的那一发也要落下 */
    appWins.delete(sid);
    const st = appCloseWait.get(sid);
    if (st) {
      clearTimeout(st.timer);
      appCloseWait.delete(sid);
    }
    notifyWindowChanged(sid, false);
  });
  notifyWindowChanged(sid, true);
  noteAppRun(sid);
  return { ok: true, id: sid, open: true, reused: false, title: winTitle, version: man.version };
}

/* 记一笔「这个应用刚被运行」（本轮需求：库页列表按最后一次运行时间倒序）。
 * 落在该应用的安装账本 installed.json 里（与 installedAt / sha256 同一份文件，随应用目录走）。
 * 纪律：
 *   · **失败绝不能影响开窗** —— 账本读不动 / 写不动就静默跳过（这只是排序用的时间戳）；
 *   · 本机自建（没有 installed.json）的应用也照写一份最小账本？不 —— 那种应用的可运行副本
 *     本来就不是「下载来的」，给它凭空造一份账本会让 kindOfManifest 的兜底分类误判成
 *     「从云端下载的」（apps-store.js:1056 的口径）。所以只在账本已存在时更新它。
 *   · 写进的是绝对时间毫秒；老账本没有这个字段 = 0（界面按「还没运行过」排到末尾）。 */
function noteAppRun(id) {
  const sid = safeAppId(id);
  if (!sid) return 0;
  try {
    const dir = dirOfApp(sid);
    if (!dir || !fs.existsSync(dir)) return 0;
    const p = installedPath(dir);
    const led = readInstalled(dir);
    if (!led) return 0; /* 没有账本 = 本机自建 / 二次开发，不硬造一份（见上） */
    const at = Date.now();
    led.lastRunAt = at;
    writeJson(p, led);
    return at;
  } catch (_) {
    return 0;
  }
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
     到点自己会关，所以这里不需要等 —— before-quit 也没法等 Promise。
     closeAppWindow 里已带「把在飞的合并写落下」。 */
  for (const id of [...appWins.keys()]) closeAppWindow(id);
  /* 非应用窗口那条路（预览租约 / 已关窗但写还在飞）也兜一次：退出前数据不能丢 */
  dataWriteFlushAll();
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
 * dir 取得到时顺手回一份（老调用方 hostSpec 等不用改）。
 * 预览态（本轮需求）：调用方是**主窗口**时，按 arg.token 认那条预览租约 →
 * 回同一个 { id, dir } 形状。于是独立窗口那二三十个宿主函数一行都不用改，
 * 预览与独立窗口走**逐字同一条实现**（白名单、上限、错误码全同源）。 */
function senderAppDir(e, arg) {
  const ownId = appIdOfSender(e);
  const pvId = ownId ? "" : previewAppIdOf(e, arg);
  const id = ownId || pvId;
  if (!id) return null;
  const k = diskKindOf(id);
  /* 根目录永远有（没配过就是默认根）：应用在默认根里也照常认出来，不再受「配没配过」影响 */
  const { root } = rootPathOf(k);
  const direct = appDirOf(root, id);
  /* 预览态下 appDirOf 认不出（应用刚被二次开发、根目录指向变了）时退回预览目录解析：
     预览协议本来就是按 previewDirOf 找目录的，两处口径必须一致。 */
  const dir = direct && fs.existsSync(direct) ? direct : pvId ? previewDirOf(id) : "";
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

async function pickAudioForApp(e, arg) {
  const own = senderAppDir(e, arg);
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
async function hostAsrStatus(e, arg) {
  const own = senderAppDir(e, arg);
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
  const own = senderAppDir(e, opts);
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
  const own = senderAppDir(e, opts);
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
   图像优先第一条 image_* 服务商。应用窗口**不能**指定服务商 / Key —— 只能给提示词与模型 id。
   注：图像那一支只在 imageSpec 里当兜底（选中的图像模型没带 providerId 时用）；
   「哪些服务商算图像后端」已按**模型形态**判（见 usableImageProviders / listCloudImageModels），
   不再只看 type 是否以 image_ 开头 —— 否则把图像模型挂在 text_openai 卡上（本机最常见）的应用
   永远出不了图。 */
function providerFor(kind) {
  const list = providersFromConfig();
  const usable = (p) => !!String(p.apiKey || "").trim() && !!String(p.baseUrl || "").trim();
  if (kind === "image") {
    const provider = usableImageProviders()[0] || null;
    if (provider) return provider;
    /* 兜底：没有任何「有图像模型」的服务商时，仍认显式 image_* 的那条（行为与旧版一致） */
    return list.filter((p) => /^image_/.test(String(p.type || "")) && usable(p))[0] || null;
  }
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
function hostModelsPayload(e, arg) {
  const own = senderAppDir(e, arg);
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
/* 应用自报能力位（读 app.json 的 capabilities）：preload 的听写条注入闸门用它 ——
 * 只在声明了 showDictate 时才注入（默认隐藏：能力位缺省 false = 不注入，宿主侧也就没有那条条）。
 * **不是权限闸**：桥上的语音 / 图像接口始终可调，这里只回答「这个应用声明的界面能力里有没有
 * 让他把听写条显示出来」。认不出应用回 ok:false。 */
function hostCapabilities(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const man = manifestOf(own.dir || "", own.id) || {};
  const caps = normCapabilities(man.capabilities);
  return { ok: true, id: own.id, capabilities: caps };
}
function hostModelGet(e, arg) {
  const own = senderAppDir(e, arg);
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
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const blocked = previewWriteBlock(e, arg, "hostSetModel");
  if (blocked) return blocked;
  const want = String((isObj(arg) && arg.model) || "").trim();
  if (!want) return bad(t("缺少模型 id"), "bad_model");
  if (want !== MODEL_AUTO && !listTextModels().some((m) => m.id === want))
    return bad(t("该模型不在 MTNode 已配置的模型清单里"), "bad_model");
  writeModelSelection(own.id, want);
  return hostModelGet(e, arg);
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
/* ---------------- appHost：图像生成（云端服务商 + 本机 SenseNova） ----------------
 *
 * 需求（用户共识）：应用默认就能用 MTNode 已配好的图像生成能力 ——
 *   · 云端：任何**有图像形态模型**的服务商卡（显式 image_* 类型，或 text_openai 卡上被
 *     config.modelKinds / 模型家族特征词判成 image 的那个模型，如 gpt-image-2-vip）；
 *   · 本地：本机 SenseNova 后端（sensenova-local 插件，127.0.0.1:8774，24G 卡出图），
 *     由 main.js 注入的宿主适配器调用（apps-store 不认识它的内部结构）；
 *   · 选择方式与文字模型同构：默认 auto（云端优先、其次本地），另给 hostImageModels()
 *     清单 + 按应用 id 持久化选择（存 apps-models.json 的 image.<appId>）；
 *   · 参数：应用只传 prompt + 尺寸语义（size），本地后端的采样步数 / 分辨率桶 / 显存档
 *     跟随节点自身配置；参考图（本机路径或 dataURL）由主进程读盘 / 缩放到长边 ≤1080；
 *   · 进度与取消：本地出图几十秒到几分钟，事件走 apps:hostStream（type:"progress"），
 *     取消走 apps:hostImageCancel；总遵守全局音视频互斥锁（忙时回 code:"busy_media"）。
 *
 * 回执（云端与本地同一形状）：{ ok, base64, dataUrl, bytes, mime, model, via, size }，
 *   本地另有 { path, width, height, seed }（产物已落盘在数据目录资产区，路径可直接交给
 *   save 类动作或画布素材库）。取消回 { ok:false, code:"cancelled" }，不是错误。
 * ─────────────────────────────────────────────────────────────────────────── */

const LOCAL_IMAGE_PROVIDER_ID = "sensenova-local";

/* 云端「可用图像服务商」：按**模型形态**认（与渲染层同一判据），不再只看服务商 type */
function usableImageProviders() {
  const cfg = readJson(configPath(), {}) || {};
  const usable = (p) => !!String(p.apiKey || "").trim() && !!String(p.baseUrl || "").trim();
  return (Array.isArray(cfg.providers) ? cfg.providers : []).filter(
    (p) => isObj(p) && usable(p) && providerHasKind(cfg, p, "image"),
  );
}
/* 云端图像模型清单（顺序 = 设置里的优先级，同一 id 只留第一个）：
   只回 id 与来源名 —— 服务商与 Key 一律不出主进程（与 hostModels 同一纪律）。 */
function listCloudImageModels() {
  const cfg = readJson(configPath(), {}) || {};
  const out = [];
  const seen = new Set();
  for (const p of usableImageProviders()) {
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const id = String(typeof m === "string" ? m : (m && m.id) || "").trim();
      if (!id || seen.has(id)) continue;
      /* 两条判据取或：① 服务商 type 显式声明是图像端点（image_*，卡上的模型名不必带图像特征词）；
         ② 模型形态被判成 image（人工覆盖 config.modelKinds > 模型家族特征词）—— 这是
         「把图像模型挂在 text_openai 卡上」那种最常见的错配能被认出来的那一半。 */
      const byType = /^image_/.test(String(p.type || ""));
      if (!byType && modelKindOf(cfg, p.id, id) !== "image") continue;
      seen.add(id);
      out.push(
        Object.assign(
          {
            id: id,
            label: id,
            providerId: String(p.id || ""),
            providerName: String(p.name || p.id || ""),
            local: false,
          },
          cloudImageCaps(cfg, p, id),
        ),
      );
    }
  }
  return out;
}
/* 本机本地图像后端（SenseNova）：装了才进清单。探测函数由 main.js 注入（轻量、不拉起后端、
   不探显存），拿不到就当一个都没装 —— 应用侧只会看到云端那一条，绝不报错。 */
/* 云端图像后端的参考图能力（图生图 / 图像编辑）—— 按**这个后端真正会走的那条接口族**声明，
 * 应用界面据此把不行的路置灰、把上限写清楚，不让它点下去才知道不行：
 *   · OpenAI 兼容图像端点（/images/edits）：多图按顺序对应提示词里的「图1 / 图2…」，
 *     但**没有**参考强度参数（strength 对云端永远为 false）；
 *   · Stability（/v2beta/stable-image/generate/core）：只吃 1 张参考图；
 *   · MJ 自定义接口：不吃参考图（界面应置灰）。
 * 上限统一按「一条消息 8 张图」的既有多模态配额（MAX_MSG_IMAGES），不另造一个数。 */
function cloudImageCaps(cfg, prov, modelId) {
  /* 判据取**服务商自己的 type**（不是 providerForRequest 纠偏后的那份）：能力由接口族决定，
     而接口族正是 type 写的；纠偏只把「混合端点上的图像模型」按形态路由，不改变这家端点
     的接口族（text_openai 的混合卡走的就是 OpenAI 兼容图像端点 = 多图 / 无强度）。 */
  const raw = String((prov || {}).type || "");
  const type = raw || String((providerForRequest(cfg, prov, modelId) || {}).type || "");
  if (type === "image_stability")
    return { refImages: true, maxRefImages: 1, strength: false };
  if (type === "image_mj")
    return { refImages: false, maxRefImages: 0, strength: false };
  return { refImages: true, maxRefImages: MAX_MSG_IMAGES, strength: false };
}
/* 本机 SenseNova 后端一次能吃的参考图张数（sensenova-pack README：/generate 带 refImages 1–4 张）；
   它也是唯一认参考强度（imgCfgScale）的后端（见 sensenova/main-sensenova.js）。 */
const LOCAL_MAX_REF_IMAGES = 4;
function localImageBackend() {
  if (typeof localImageHost !== "function") return null;
  let info = null;
  try {
    info = localImageHost() || null;
  } catch {
    info = null;
  }
  if (!info || info.installed !== true) return null;
  return {
    id: LOCAL_IMAGE_PROVIDER_ID,
    label: String(info.label || t("本机图像生成（SenseNova）")),
    providerName: "",
    local: true,
    ready: info.ready === true,
    phase: String(info.phase || ""),
    vramMode: String(info.vramMode || ""),
    /* 本机能吃多张参考图，也能给参考强度（imgCfgScale）—— 与云端那套同名字段，应用侧一套判据 */
    refImages: true,
    maxRefImages: LOCAL_MAX_REF_IMAGES,
    strength: true,
  };
}
/* 主窗口渲染层的图像后端清单（函数节点的「图像后端」按钮用它列候选）：与应用窗口的
   hostImageModels 同一份清单（云端图像服务商 + 本机 SenseNova），每项带参考图能力三字段。
   不含「谁选了哪只」—— 应用窗口那份按应用 id 存，函数节点那份存节点自身字段。 */
function imageBackendsForUi() {
  const cloud = listCloudImageModels();
  const local = localImageBackend();
  const models = cloud.concat(local ? [local] : []);
  return {
    ok: true,
    models: models,
    hasAny: models.length > 0,
    hasCloud: cloud.length > 0,
    hasLocal: !!local,
    defaultModel: cloud.length ? cloud[0].id : local ? local.id : "",
  };
}
function readImageSelection(appId) {
  const v = (readModelSelections() || {}).image;
  const per = isObj(v) ? v : {};
  const raw = per[String(appId || "")];
  return typeof raw === "string" ? raw.trim() : "";
}
function writeImageSelection(appId, model) {
  const aid = String(appId || "");
  if (!aid) return;
  try {
    const all = readModelSelections();
    const per = isObj(all.image) ? all.image : {};
    const next = String(model || "").trim();
    if (!next || next === MODEL_AUTO) delete per[aid];
    else per[aid] = next;
    all.image = per;
    writeJson(modelsFilePath(), all);
  } catch (err) {
    console.warn("[apps-models] 写入失败：" + ((err && err.message) || err));
  }
}
/* 本次要用的图像后端：显式给的清单内 id > 该应用存过的选择 > auto（云端优先，其次本机）
   越界 / 后端不存在回 { error }（错误码即契约，绝不静默换一个后端出图）。 */
function resolveImagePick(appId, modelId) {
  const cloud = listCloudImageModels();
  const local = localImageBackend();
  const all = cloud.concat(local ? [{ id: local.id, label: local.label, local: true }] : []);
  if (!all.length) return { error: "no_provider" };
  const want = String(modelId == null ? "" : modelId).trim() || readImageSelection(appId);
  if (!want || want === MODEL_AUTO) {
    if (cloud.length) return { auto: true, ...cloud[0] };
    return { auto: true, id: local.id, label: local.label, local: true };
  }
  const hit = all.find((m) => m.id === want);
  if (!hit) return { error: "bad_model" };
  return Object.assign({ auto: false }, hit);
}
function imageModelsPayload(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const cloud = listCloudImageModels();
  const local = localImageBackend();
  const saved = readImageSelection(own.id);
  const ids = cloud.map((m) => m.id).concat(local ? [local.id] : []);
  return {
    ok: true,
    models: cloud.concat(local ? [local] : []),
    selected: saved && ids.indexOf(saved) >= 0 ? saved : MODEL_AUTO,
    hasAny: ids.length > 0,
    hasCloud: cloud.length > 0,
    hasLocal: !!local,
    localReady: !!(local && local.ready),
    defaultModel: cloud.length ? cloud[0].id : local ? local.id : "",
    /* 全局音视频互斥锁被别的任务占着时先告诉应用，别让它点了才发现忙 */
    busy: !!(readMediaLock() || {}).nodeId,
  };
}
function hostImageModelGet(e, arg) {
  const p = imageModelsPayload(e, arg);
  if (p.ok !== true) return p;
  delete p.models;
  return p;
}
function hostImageModelSet(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const blocked = previewWriteBlock(e, arg, "hostImageSetModel");
  if (blocked) return blocked;
  const want = String((isObj(arg) && arg.model) || "").trim();
  if (!want) return bad(t("缺少模型 id"), "bad_model");
  if (want !== MODEL_AUTO && resolveImagePick(own.id, want).error)
    return bad(t("该图像模型不在 MTNode 已配置的清单里"), "bad_model");
  writeImageSelection(own.id, want);
  return hostImageModelGet(e, arg);
}
/* 参考图（图生图 / 图像编辑）：dataURL 或本机绝对路径，逐张读盘 / 解码 / 缩放到长边 ≤1080，
   页面拿不到任何文件内容（与多模态消息同一条纪律）。回 { images:[dataURL], warnings:[] }。 */
function imageRefDataUrls(opts) {
  const o = isObj(opts) ? opts : {};
  const src = [].concat(
    Array.isArray(o.images) ? o.images : [],
    o.image == null || o.image === "" ? [] : [o.image],
    Array.isArray(o.refImages) ? o.refImages : [],
    o.refImage == null || o.refImage === "" ? [] : [o.refImage],
  );
  const images = [];
  const warnings = [];
  const quota = { bytes: 0 };
  for (const raw of src) {
    if (images.length >= MAX_MSG_IMAGES) {
      warnings.push("ref_image_too_many: 参考图超过 " + MAX_MSG_IMAGES + " 张上限，已忽略多余的");
      break;
    }
    const one = imagePartUrl(raw, quota);
    if (one.error) {
      warnings.push("ref_image_skipped: " + one.error);
      continue;
    }
    images.push(one.url);
  }
  return { images: images, warnings: warnings };
}
/* 应用侧参考强度（strength）：0–1 归一，越界夹紧，空 / 非数 = 不传（null）。
 * 别名 imgStrength / refStrength / imgCfgScale 一并认（老写法与后端原生名都收），
 * 但**语义只有一种**：0 = 参考图只作前缀条件（本机后端 imgCfgScale 1.0 = 官方默认关闭图像 CFG），
 * 1 = 最强（映射到 4.0，与节点默认 cfgScale 同尺度，见 sensenova-pack engine 的说明）。 */
function strengthOf(opts) {
  const o = isObj(opts) ? opts : {};
  let raw = o.strength;
  if (raw == null || raw === "") raw = o.refStrength;
  if (raw == null || raw === "") raw = o.imgStrength;
  if (raw == null || raw === "") raw = o.imgCfgScale;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}
/* strength（0–1）→ 本机后端 imgCfgScale：1.0 = 关闭图像 CFG（官方默认），1 映射到 4.0（与 cfgScale 同尺度）。
   strengthOf 为 null 时返回 null = 不下发，后端用官方默认 1.0。 */
function imgCfgScaleOf(opts) {
  const s = strengthOf(opts);
  if (s == null) return null;
  if (s <= 0) return 1;
  return 1 + 3 * s;
}
/* 本次图像请求的 spec：云端走 aiCall 内核（与画布 proc_image 同一份 buildRequestSpec，
   于是「配成 text_openai 的混合端点」也照旧按 OpenAI 兼容图像端点发）。 */
function imageSpec(id, pick, opts) {
  const o = isObj(opts) ? opts : {};
  let provider = pick.providerId
    ? providersFromConfig().find((p) => String(p.id || "") === String(pick.providerId)) || null
    : null;
  if (!provider) provider = providerFor("image");
  if (!provider) return { error: "no_provider" };
  /* 模型形态与服务商类型不符时用「改过 type 的副本」（原对象一字不动）—— 与画布节点同一口径 */
  const cfg = readJson(configPath(), {}) || {};
  const refs = imageRefDataUrls(o);
  const warnings = refs.warnings.slice();
  /* 参考强度（strength）只在**本机后端**有意义：云端 OpenAI 兼容图像端点没有这个参数，
     绝不假装支持 —— 传了就在回执里如实说明并忽略（与「不降级、明确提示」同一口径）。 */
  if (strengthOf(o) != null)
    warnings.push(
      "strength_unsupported: " +
        t("当前图像后端不支持参考强度（strength），本次已忽略；本机 SenseNova 后端支持它"),
    );
  return {
    spec: {
      provider: providerForRequest(cfg, provider, pick.id) || provider,
      kind: "image",
      model: String(pick.id || ""),
      prompt: String(o.prompt || "").slice(0, MAX_PROMPT),
      size: String(o.size || ""),
      quality: String(o.quality || ""),
      background: String(o.background || ""),
      /* 参考图（图生图 / 图像编辑）：**整组**下发。这里曾经只给第 1 张（refImage），
         而 buildRequestSpec 的 OpenAI 兼容分支只在 images 非空时才走 /images/edits，
         于是云端应用侧的参考图根本没发出去（回落成纯文生图）—— 该 bug 的回归见
         test/smoke-apps-image-capabilities.js 的 [4] 段。refImage 仍保留：Stability
         那条路（image_stability）吃的就是它。 */
      refImage: refs.images[0] || "",
      images: refs.images.slice(),
    },
    warnings: warnings,
  };
}
/* 本地（SenseNova）出图：拍一个唯一 nodeId 占全局互斥锁 → 宿主生成（产物落数据目录）
 *   → 读回字节成 base64 / dataURL。进度：生成期间轮询宿主快照（1.2s），经 emit 推给应用；
 *   取消：把请求登记成 abort，轮询里发现就走宿主的 cancel（后端在下一个采样步边界停下）。 */
let imageReqSeq = 0;
async function generateLocalImage(appId, pick, opts, img, emit, reqId, outDir) {
  const o = isObj(opts) ? opts : {};
  if (typeof localImageGenerate !== "function") return bad(t("本机图像后端不可用"), "no_local_backend");
  const req = {
    appId: appId,
    nodeId: "app-" + appId,
    abort: false,
    cancelled: false,
    createdAt: Date.now(),
    emit: emit,
  };
  if (reqId) imageReqs.set(String(reqId), req);
  const timer = setInterval(async () => {
    if (req.abort && !req.cancelled) {
      req.cancelled = true;
      try {
        if (typeof localImageCancel === "function") await localImageCancel(req.nodeId);
      } catch (_) {}
      return;
    }
    try {
      const snap = typeof localImageSnapshot === "function" ? await localImageSnapshot(req.nodeId) : null;
      if (snap && !req.abort)
        emit("progress", {
          stage: String(snap.stage || ""),
          message: String(snap.message || ""),
          pct: Number(snap.pct) || 0,
          step: Number(snap.step) || 0,
          totalSteps: Number(snap.totalSteps) || 0,
          elapsedSec: Number(snap.elapsedSec) || 0,
        });
    } catch (_) {}
  }, 1200);
  if (timer.unref) timer.unref();
  try {
    if (req.abort) return { ok: false, code: "cancelled", error: "已取消" };
    emit("progress", { stage: "prepare", message: t("正在启动本机图像后端…"), pct: 1 });
    const r = await localImageGenerate({
      /* appId 透传给适配器：本机后端把产物落这个应用自己的数据目录（apps-data/<id>/gen） */
      appId: appId,
      nodeId: req.nodeId,
      prompt: String(o.prompt || "").slice(0, MAX_PROMPT),
      /* 画幅语义：应用给 ratio（如 "16:9"）或 size（"1280x720"）都收，宿主按官方桶对齐 */
      ratio: String(o.ratio || o.aspect || ""),
      width: Number(o.width) || 0,
      height: Number(o.height) || 0,
      refImages: img.images,
      /* 参考强度：应用侧 0–1 → 本机后端 imgCfgScale（1.0 = 关闭图像 CFG 的官方默认，1 → 4.0）。
         不传 = 后端按官方默认出图（与旧调用完全一致）。 */
      imgCfgScale: imgCfgScaleOf(o) == null ? undefined : imgCfgScaleOf(o),
      /* 产物目录（只有宿主内部那条路会给：函数节点把图落画布资产目录）；
         应用通道不给 = 该应用自己的数据目录 gen/。 */
      outputDir: String(outDir || ""),
      requestId: reqId ? String(reqId) : "",
    });
    if (req.abort || (r && (r.cancelled || r.error === "cancelled")))
      return { ok: false, code: "cancelled", error: "已取消" };
    if (!r || r.ok !== true)
      return bad(String((r && (r.message || r.error)) || t("本机图像生成失败")), String((r && r.error) || "local_failed"));
    const file = String(r.path || "");
    let buf = null;
    try {
      buf = fs.readFileSync(file);
    } catch (_) {
      buf = null;
    }
    const ext = String(path.extname(file)).slice(1).toLowerCase() || "png";
    const mime = IMG_EXT_TYPES[ext] || "image/png";
    const b64 = buf ? buf.toString("base64") : "";
    return Object.assign(
      {
        ok: true,
        via: "local",
        backend: LOCAL_IMAGE_PROVIDER_ID,
        model: LOCAL_IMAGE_PROVIDER_ID,
        mime: mime,
        base64: b64,
        dataUrl: b64 ? "data:" + mime + ";base64," + b64 : "",
        bytes: buf ? buf.length : Number(r.bytes) || 0,
        file: file,
        size: String(r.ratio || o.size || ""),
        warnings: Array.isArray(r.warnings) ? r.warnings.slice(0, 8) : [],
      },
      r,
    );
  } catch (err) {
    return fail(err);
  } finally {
    clearInterval(timer);
    if (reqId) imageReqs.delete(String(reqId));
  }
}
/* 云端出图（每次一张）：回 base64 + dataUrl（与旧行为一致）+ 尺寸与耗时旁证 */
async function generateCloudImage(pick, built, emit) {
  if (typeof aiCall !== "function") return bad(t("模型调用内核不可用"), "no_kernel");
  emit("progress", { stage: "request", message: t("正在请求图像服务商…"), pct: 1 });
  const started = Date.now();
  const r = await aiCall(built.spec);
  const b64 = String((r && r.base64) || "");
  const ext = String((r && r.ext) || "png");
  if (!b64) return bad(t("响应无图像数据"), "no_image");
  const mime = ext === "jpeg" || ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return {
    ok: true,
    via: "cloud",
    model: String(pick.id || ""),
    providerName: String(pick.providerName || ""),
    mime: mime,
    base64: b64,
    dataUrl: "data:" + mime + ";base64," + b64,
    bytes: Buffer.from(b64, "base64").length,
    size: String(built.spec.size || ""),
    elapsedSec: Math.round((Date.now() - started) / 100) / 10,
    warnings: built.warnings,
  };
}
async function hostImageStream(e, opts) {
  const own = senderAppDir(e, opts);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const blockedIn = previewWriteBlock(e, opts, "imageGen");
  if (blockedIn) return blockedIn;
  const o = isObj(opts) ? opts : {};
  const reqId = String(o.reqId || "");
  const emit = (type, data) => {
    emitHostStreamFor(e, opts, Object.assign({ reqId: reqId, type: type }, data || {}));
  };
  try {
    if (!String(o.prompt || "").trim()) return bad(t("缺少提示词"), "no_prompt");
    const pick = resolveImagePick(own.id, o.model || o.imageModel);
    if (pick.error === "no_provider")
      return bad(
        t("未配置可用的图像后端（请在「设置 · API/配置」里配图像服务商，或安装本机 SenseNova 插件）"),
        "no_provider",
      );
    if (pick.error) return bad(t("该图像模型不在 MTNode 已配置的清单里"), "bad_model");
    const img = imageRefDataUrls(o);
    if (pick.local) return await generateLocalImage(own.id, pick, o, img, emit, reqId);
    const built = imageSpec(own.id, pick, o);
    if (built.error) return bad(t("未配置可用的图像服务商（请在「设置 · API/配置」中填写）"), built.error);
    return await generateCloudImage(pick, built, emit);
  } catch (err) {
    const msg = String((err && err.message) || err);
    const code = callErrCode(err);
    emit("error", { error: msg, code: code });
    return { ok: false, error: msg, code: code };
  }
}
/* 显式图生图 / 图像编辑（appHost.imageEdit）：参考图**必填**，其余与 hostImageStream 同一份实现。
   没有参考图不是「降级成文生图」，而是明确回错 —— 与产品「宁可报错也不偷偷换路」的口径一致。 */
async function hostImageEdit(e, opts) {
  const own = senderAppDir(e, opts);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const blockedIn = previewWriteBlock(e, opts, "imageEdit");
  if (blockedIn) return blockedIn;
  const o = isObj(opts) ? opts : {};
  const refs = []
    .concat(
      Array.isArray(o.images) ? o.images : [],
      o.image == null || o.image === "" ? [] : [o.image],
      Array.isArray(o.refImages) ? o.refImages : [],
      o.refImage == null || o.refImage === "" ? [] : [o.refImage],
    )
    .filter((x) => x != null && x !== "");
  if (!refs.length)
    return bad(t("图像编辑需要至少一张参考图（opts.images）"), "no_ref_image");
  return hostImageStream(e, o);
}
/* 宿主内部出图（函数节点的 mtnode.image(...) 走这里，main.js 的 fnImageCall 调用）：
   与 appHost.imageGen 同一份内核 —— 同一份后端清单与选择解析、同一份参考图读盘 / 缩放、
   同一把全局音视频互斥锁、同一套错误码与 warning。差别只有两处：
     · 调用方不是应用窗口（没有 sender 可校验），appId 由调用方给（函数节点用它自己的 id）；
     · 产物目录可由调用方指定（函数节点落画布资产目录），不给就落 <数据目录>/apps-data/<id>/gen。
   回执形状与 imageGen 完全一致（ok / base64 / dataUrl / bytes / mime / via / model / warnings）。 */
async function hostImageGenerate(arg) {
  const a = isObj(arg) ? arg : {};
  const appId = String(a.appId || a.nodeId || "fn-node");
  const o = isObj(a.opts) ? a.opts : {};
  const outDir = String(o.outputDir || "");
  if (!String(o.prompt || "").trim()) return bad(t("缺少提示词"), "no_prompt");
  const pick = resolveImagePick(appId, o.model || o.imageModel);
  if (pick.error === "no_provider")
    return bad(
      t("未配置可用的图像后端（请在「设置 · API/配置」里配图像服务商，或安装本机 SenseNova 插件）"),
      "no_provider",
    );
  if (pick.error) return bad(t("该图像模型不在 MTNode 已配置的清单里"), "bad_model");
  const img = imageRefDataUrls(o);
  const emit = () => {};
  try {
    if (pick.local) return await generateLocalImage(appId, pick, o, img, emit, "", outDir);
    const built = imageSpec(appId, pick, o);
    if (built.error)
      return bad(t("未配置可用的图像服务商（请在「设置 · API/配置」中填写）"), built.error);
    return await generateCloudImage(pick, built, emit);
  } catch (err) {
    return fail(err);
  }
}
/* 取消：应用侧按 reqId 请求取消（本地后端在下一个采样步边界停下；云端请求不中断，
   只把登记撤掉，结果由调用方自己忽略）。 */
function hostImageCancel(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const reqId = String((isObj(arg) && (arg.reqId || arg.id)) || "");
  const req = reqId ? imageReqs.get(reqId) : null;
  if (!req || req.appId !== own.id) return { ok: true, cancelled: false };
  req.abort = true;
  return { ok: true, cancelled: true, via: "local" };
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
  const own = senderAppDir(e, opts);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const built = hostSpec(own.id, "text", opts);
  if (built.error) return bad(built.error, built.code || "no_provider");
  const wc = e.sender;
  const reqId = String((isObj(opts) && opts.reqId) || "");
  const emit = (type, data) => {
    emitHostStreamFor(e, opts, Object.assign({ reqId: reqId, type: type }, data || {}));
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
/* 图像生成（旧签名，一次调用一张）：实现统一走 hostImageStream —— 云端 / 本机两条路、
   参考图、进度与取消都在那儿。这里只保证**老调用的行为与回执不变**（ok/base64/dataUrl/bytes/mime），
   额外多回 via / model / size 等旁证字段（只增不改）。 */
async function hostImage(e, opts) {
  return hostImageStream(e, Object.assign({}, isObj(opts) ? opts : {}, { legacy: true }));
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
/* ── 合并写（本次修复：应用「启动后卡顿、预览却顺」的真差异）────────────────────────
 *
 * 现场：应用在**独立窗口**里每次操作都会 store.set(整份 state) → 防抖 400ms → dataWrite；
 * 预览帧那条路在「同一应用已开在独立窗口」时是**只读**的（写类能力同步拒），
 * 所以预览一条盘都不写 —— 这就是「预览顺、启动后卡」的来源，不是渲染也不是画布。
 *
 * 代价的实测口径（test/_perf-probe/disk-write-cost.cjs，本机）：
 *   · 主进程 writeJson 一发：3KB ≈ 0.8ms · 0.5MB ≈ 12ms · 2MB ≈ 45ms · 8MB ≈ 240ms
 *   · 走完整链路（渲染层 invoke → 主进程写盘 → 回包，含结构化克隆）：
 *     3KB ≈ 1.8ms · 0.5MB ≈ 94ms · 2MB ≈ 372ms      ← 每次操作都付这一笔
 *   应用存档常见的是「已探索格子的整盘快照」，玩得越久越大，于是越玩越卡。
 *
 * 对策（不动应用、不改协议、不丢数据）：
 *   · 同一次「写风暴」里只把**最后一次**落盘（新状态全量覆盖旧状态，中间态没有价值）；
 *   · 合并窗口 120ms + 上限 1.5s（连续写不停也不会把数据无限期压着不落）；
 *   · 越过 20 发就**当场落盘**并把窗口顺延 —— 上一次卡 2MB 同步写的教训：宁可少写，
 *     也不能让主进程一发接一发地同步写盘（那会把整个应用窗口的输入一起拖住）。
 *   · 同时开着的**不同文件**各自独立，互不合并；读盘仍以盘上为准（读之前先把在飞的落下）。 */
const DATA_WRITE_COALESCE_MS = 120; /* 合并窗口：同文件这段时间内的多次写只落最后一次 */
const DATA_WRITE_MAX_DELAY_MS = 1500; /* 上限：连续写不停时，最多压这么久就必须落一次 */
const DATA_WRITE_BURST = 20; /* 连发上限：跨过去就当场落一次并把窗口顺延 */
const dataWritePending = new Map(); /* file → { data, timer, firstAt, burst } */
function dataWriteFlushAll() {
  const out = [];
  for (const file of [...dataWritePending.keys()]) {
    const p = dataWritePending.get(file);
    if (!p) continue;
    if (p.timer) clearTimeout(p.timer);
    dataWritePending.delete(file);
    try {
      writeDataFile({ dir: path.dirname(file), file: file, name: path.basename(file) }, p.data);
      out.push({ file: file });
    } catch (err) {
      console.warn("[apps] 应用数据落盘失败：" + ((err && err.message) || err));
    }
  }
  return out;
}
function writeDataFile(target, data) {
  const body = JSON.stringify(isObj(data) ? data : {});
  if (body.length > MAX_DATA_FILE) return bad(t("应用数据超出上限（2MB）"), "storage_full");
  if (target.dir && !fs.existsSync(target.dir)) mk(target.dir);
  writeJson(target.file, isObj(data) ? data : {});
  return { ok: true, file: target.file, dir: target.dir, bytes: body.length };
}
/* 应用侧 dataWrite 的真正落点：能合并就合并，合并窗到点（或连发过头）才真写。
   返回值语义与 writeDataFile 一致（ok/bytes/file），只是「什么时候真落盘」变了。 */
function queueDataWrite(target, data) {
  const body = JSON.stringify(isObj(data) ? data : {});
  if (body.length > MAX_DATA_FILE) return bad(t("应用数据超出上限（2MB）"), "storage_full");
  const now = Date.now();
  const prev = dataWritePending.get(target.file);
  if (prev) {
    /* 连发过头：先把压着的那一发落下去（一次同步写，2MB ≈ 45ms），
       新的一份重新起一个合并窗，避免把 20+ 次整份写挤在同一个 tick 里连着同步写。 */
    if (prev.burst >= DATA_WRITE_BURST) {
      if (prev.timer) clearTimeout(prev.timer);
      dataWritePending.delete(target.file);
      try {
        writeDataFile(target, prev.data);
      } catch (err) {
        console.warn("[apps] 应用数据落盘失败：" + ((err && err.message) || err));
      }
    } else if (prev.timer) {
      clearTimeout(prev.timer);
    }
  }
  const cur = dataWritePending.get(target.file);
  const firstAt = cur && cur.data ? cur.firstAt : now;
  const burst = (cur && cur.burst) || 0;
  const wait = Math.min(
    DATA_WRITE_COALESCE_MS,
    Math.max(0, DATA_WRITE_MAX_DELAY_MS - (now - firstAt)),
  );
  if (cur && cur.timer) clearTimeout(cur.timer);
  const rec = { data: isObj(data) ? data : {}, firstAt: firstAt, burst: burst + 1, timer: null };
  rec.timer = setTimeout(() => {
    const p = dataWritePending.get(target.file);
    if (!p || p !== rec) return;
    dataWritePending.delete(target.file);
    try {
      writeDataFile(target, rec.data);
    } catch (err) {
      console.warn("[apps] 应用数据落盘失败：" + ((err && err.message) || err));
    }
  }, wait);
  try {
    if (rec.timer && typeof rec.timer.unref === "function") rec.timer.unref();
  } catch {}
  dataWritePending.set(target.file, rec);
  return { ok: true, file: target.file, dir: target.dir, bytes: body.length, coalesced: true };
}
/* 读之前先把「这个应用名下所有在飞的合并写」落到盘上：
   dataWrite 是整份替换，若读到的还是旧的那一份，应用会以为自己的写丢了。
   顺带把关窗 / 退出也走这里（关窗前必须把最后一发落下）。
   认「这个应用的文件」走**目录精确比对**（默认数据文件夹 + 用户选过的那个），
   不用写白名单反查 —— 两个应用把数据文件夹指到同一处时，白名单会互相串。 */
function dataWriteFlushApp(id) {
  const sid = safeAppId(id);
  if (!sid || !dataWritePending.size) return;
  const dirs = [];
  try {
    dirs.push(appDataRootPath(sid));
  } catch (err) {
    /* 数据目录还没就绪：这一发落不了盘，但绝不因为 flush 失败把调用方（关窗 / 读盘）带崩 */
    return;
  }
  const ptr = readDataDirPointer(sid);
  if (ptr && ptr.dir) dirs.push(path.resolve(ptr.dir));
  const want = dirs.filter(Boolean).map((d) => path.resolve(d).toLowerCase());
  for (const file of [...dataWritePending.keys()]) {
    const dir = path.resolve(path.dirname(file)).toLowerCase();
    if (want.indexOf(dir) < 0) continue;
    const p = dataWritePending.get(file);
    if (p.timer) clearTimeout(p.timer);
    dataWritePending.delete(file);
    try {
      writeDataFile({ dir: path.dirname(file), file: file, name: path.basename(file) }, p.data);
    } catch (err) {
      console.warn("[apps] 关窗前的应用数据落盘失败：" + ((err && err.message) || err));
    }
  }
}
/* 老 storage 那组用的「内部 kv」：读 → 迁老档 → 取 obj.kv；写 → 整份替回去 */
function readKvOf(id) {
  dataWriteFlushApp(id); /* 读之前先落盘：合并窗里压着的那一份不能被读漏 */
  const r = readAppData(id, DATA_FILE);
  const data = isObj(r.data) ? r.data : {};
  return { data: data, kv: isObj(data.kv) ? data.kv : {}, file: r.file, migrated: !!r.migrated };
}

/* ---------------- appHost：应用能力位（capabilities） ----------------
 *
 * 需求（用户共识）：默认应用**不再携带语音转文字** —— 「这个应用要不要文字输入 / 要不要在
 * 窗口底部显示听写条 / 要不要图像生成」写在 app.json 的 capabilities 里（见 apps-capabilities.js）：
 *   · textInput   决定脚手架那两份语音模块（speech.js / speech.css）补不补进应用目录；
 *   · showDictate 决定宿主注不注入听写条（preload-app.js 的闸门）与默认页注不注入 dict.js；
 * 两者都缺省 false（新应用浮层里也不勾）。能力位是**静态声明**，不是权限闸
 * （桥上的接口始终在，旧应用不会突然报错）。
 *
 * 两条主进程入口（应用中心渲染层用）：
 *   appCapabilitiesGet({ id })             → { ok, capabilities, list:[{id,label,hint,on}] }
 *   appCapabilitiesSet({ id, capabilities, regenEntry? })
 *        · 整份替换能力位（缺的键按 false）；
 *        · textInput 打开 → 把随包脚手架的 speech.js / speech.css 补进应用目录 + 按模板重生成
 *          入口页（入口页本是模板生成的一份独立文件，「换风格」也是这么重生成的）；
 *        · textInput 关掉 → 反向：重生成入口页并删掉这两个文件；
 *        · showDictate 打开 / 关掉 → 只影响入口页里那份 dict.js 内联（宿主注入侧看同一个位）；
 *        · regenEntry=false 时只写声明、不碰文件（给「我自己写的入口页」留出口）。
 * ─────────────────────────────────────────────────────────────────────── */
function appCapById(id, kind) {
  const sid = safeAppId(id);
  if (!sid) return { error: bad(t("应用 id 不合法"), "bad_id") };
  /* 类型：调用方点名了就取那一边（开发页传 dev —— 同 id 在下载根也有一份时，
     能力位写到别的副本上等于改了个用户看不见的文件） */
  const dir = dirOfApp(sid, kind ? kindOfRoot(kind) : "");
  if (!dir || !fs.existsSync(dir)) return { error: Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: sid }) };
  /* root = 它所在的那一套根（下载根 / 项目根）：语音文件同步等下游按它拼路径 */
  return { id: sid, dir: dir, root: path.dirname(dir) };
}
function appCapabilitiesGet(arg) {
  const a = isObj(arg) ? arg : {};
  const hit = appCapById(a.id, a.kind);
  if (hit.error) return hit.error;
  const man = manifestOf(hit.dir, hit.id) || {};
  const caps = normCapabilities(man.capabilities);
  return { ok: true, id: hit.id, capabilities: caps, list: capabilitiesForUi(caps, appLocale()) };
}
function appCapabilitiesSet(arg) {
  const a = isObj(arg) ? arg : {};
  const hit = appCapById(a.id, a.kind);
  if (hit.error) return hit.error;
  const prev = manifestOf(hit.dir, hit.id) || {};
  const caps = normCapabilities(a.capabilities);
  const regen = a.regenEntry !== false;
  const man = writeManifest(hit.dir, { capabilities: caps }, prev);
  const out = { ok: true, id: hit.id, capabilities: caps, wroteFiles: [] };
  if (regen) {
    /* 语音模块两份文件：声明打开就补，关掉就撤（撤的是我们补的那两份，绝不碰别的文件） */
    const speech = syncSpeechFiles(hit.dir, caps);
    out.wroteFiles = speech;
    const entry = safeEntry(man.entry) || SUB.index;
    const abs = resolveInside(hit.dir, entry);
    if (abs) {
      try {
        fs.writeFileSync(abs, defaultPageHtml(man), "utf8");
        out.regeneratedEntry = entry;
      } catch (err) {
        return fail(err);
      }
    }
  }
  out.capabilities = normCapabilities(readManifest(hit.dir) ? (readManifest(hit.dir) || {}).capabilities : caps);
  out.list = capabilitiesForUi(out.capabilities, appLocale());
  return out;
}
/* 应用侧展示语言（config.json 的 locale；hostLocale 由 main.js 注入，取不到按中文） */
function appLocale() {
  try {
    if (typeof hostLocale === "function") return String(hostLocale() || "zh");
  } catch {}
  try {
    return String((readJson(configPath(), {}) || {}).locale || "zh");
  } catch {
    return "zh";
  }
}
/* 脚手架里的语音模块文件（templates/app-scaffold/speech.js + speech.css）：
   声明了 textInput 才复制进应用目录（README 里写明这条口径）。 */
const SCAFFOLD_DIR = path.join(__dirname, "templates", "app-scaffold");
function syncSpeechFiles(dir, caps) {
  const wrote = [];
  const on = capabilityOn(caps, "textInput");
  for (const name of ["speech.js", "speech.css"]) {
    const src = path.join(SCAFFOLD_DIR, name);
    const dst = path.join(dir, name);
    try {
      if (on) {
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, dst);
        wrote.push(name);
      } else if (fs.existsSync(dst)) {
        fs.unlinkSync(dst);
        wrote.push("-" + name);
      }
    } catch (err) {
      console.warn("[apps-cap] " + name + " 同步失败：" + ((err && err.message) || err));
    }
  }
  return wrote;
}
function hostDataDirGet(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  try {
    const dir = appDataDirOf(own.id);
    const p = readDataDirPointer(own.id);
    const root = appDataRootPath(own.id);
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
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  /* 数据文件夹那一组里真正会改东西的两条（换落点 / 回默认）：预览只读时一并拒 ——
     预览里点开系统选择框改掉落点，独立窗口那边下次落盘就换地方了，这属于「写」。 */
  const blocked = previewWriteBlock(e, arg, "dataDirPick");
  if (blocked) return blocked;
  const r = await pickAppDataDir(own.id, isObj(arg) ? arg : {});
  if (!r || !r.ok) return r || bad(t("选择数据文件夹失败"), "pick_failed");
  return Object.assign({}, r, { exists: fs.existsSync(r.dir) });
}
async function hostDataDirOpen(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  return openAppDataDir(own.id);
}
/* 回到默认数据文件夹：只删「用户选过」的指针，原目录里的数据原样留着 */
function hostDataDirReset(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const blocked = previewWriteBlock(e, arg, "dataDirReset");
  if (blocked) return blocked;
  try {
    const r = clearDataDirPointer(own.id);
    return Object.assign({}, r, { exists: fs.existsSync(r.dir) });
  } catch (err) {
    return fail(err);
  }
}
function hostDataRead(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const name = (isObj(arg) && arg.file) || DATA_FILE;
  dataWriteFlushApp(own.id); /* 读之前先把合并窗里压着的那一份落下（整份替换语义） */
  const r = readAppData(own.id, name);
  return { ok: true, data: r.data, file: r.file, migrated: r.migrated, dir: appDataDirOf(own.id) };
}
function hostDataWrite(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const blocked = previewWriteBlock(e, arg, "dataWrite");
  if (blocked) return blocked;
  const a = isObj(arg) ? arg : {};
  const target = resolveDataTarget(own.id, a.file);
  if (!target) return bad(t("数据文件名不合法"), "bad_file");
  return queueDataWrite(target, a.data);
}

/* ---------------- appHost：老存储通道（内部 kv，走同一个 data.json） ---------------- */

function normStorageKey(key) {
  const k = String(key == null ? "" : key).trim();
  if (!k || k.length > STORAGE_KEY_MAX) return "";
  return k;
}
function hostStorageGet(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const key = normStorageKey(isObj(arg) ? arg.key : arg);
  if (!key) return bad(t("存储键不合法"), "bad_key");
  const r = readKvOf(own.id);
  return { ok: true, key: key, value: Object.prototype.hasOwnProperty.call(r.kv, key) ? r.kv[key] : null };
}
function hostStorageSet(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const blocked = previewWriteBlock(e, arg, "storageSet");
  if (blocked) return blocked;
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
  const w = queueDataWrite(target, data);
  if (!w.ok) return w;
  return { ok: true, bytes: w.bytes, file: w.file };
}
function hostStorageAll(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  return { ok: true, kv: readKvOf(own.id).kv };
}
function hostStorageRemove(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  const blocked = previewWriteBlock(e, arg, "storageRemove");
  if (blocked) return blocked;
  const key = normStorageKey(isObj(arg) ? arg.key : arg);
  if (!key) return bad(t("存储键不合法"), "bad_key");
  const target = resolveDataTarget(own.id, DATA_FILE);
  if (!target) return bad(t("数据文件名不合法"), "bad_file");
  const r = readKvOf(own.id);
  const data = r.data;
  const kv = Object.assign({}, r.kv);
  delete kv[key];
  data.kv = kv;
  const w = queueDataWrite(target, data);
  if (!w) return bad(t("写入失败"), "write_failed");
  return w;
}

/* ---------------- appHost：账号摘要 ---------------- */

/* 账号摘要：直接回 auth-store 的 state（本来就不含 token）；应用窗口只看得到「有没有登录 + 谁」 */
function hostAccount(e, arg) {
  const own = senderAppDir(e, arg);
  if (!own) return bad(t("不是应用窗口"), "not_app");
  try {
    const st = authState() || {};
    return {
      ok: true,
      loggedIn: !!st.loggedIn,
      /* 只回 PublicUser 白名单字段：token / 加密材料一律不出这一层 ——
         authState() 的 user 是**主进程内部那份**（可能带 token），把它原样交出去
         等于把登录凭据发给应用页（本轮做预览桥时发现的既有越界，一并收住）。 */
      user: publicUserOf(st.user),
      encryption: String(st.encryption || ""),
    };
  } catch (err) {
    return fail(err);
  }
}
/* 账号摘要里允许出主进程的那几个字段（其余一律丢掉）：
   口径 = auth-store.js 的 USER_FIELDS / sanitizeUser（PublicUser 白名单，见 docs/auth-design.md）。
   这里不 require 那份实现（apps-store 不该反向依赖 auth-store），照抄同一张表并在这里说明同源；
   表变了要一起改（两处都写着这一句）。 */
const PUBLIC_USER_FIELDS = [
  "id",
  "username",
  "nickname",
  "avatar",
  "phone",
  "phoneVerified",
  "hasPassword",
  "bindings",
  "downloadsReceived",
  "likesReceived",
  "balanceYuan",
  "createdAt",
  "isAdmin",
];
function publicUserOf(u) {
  if (!u || typeof u !== "object") return null;
  const out = {};
  for (const k of PUBLIC_USER_FIELDS) if (u[k] !== undefined) out[k] = u[k];
  return out;
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
  /* 本机图像后端（SenseNova）：四项都由 main.js 注入 —— 探测（装了没 / 相位）、出图、取消、
     进度快照。apps-store 不认识它的内部结构（与 getDsh 同一条纪律）。 */
  if (typeof opts.localImageHost === "function") localImageHost = opts.localImageHost;
  if (typeof opts.localImageGenerate === "function") localImageGenerate = opts.localImageGenerate;
  if (typeof opts.localImageCancel === "function") localImageCancel = opts.localImageCancel;
  if (typeof opts.localImageSnapshot === "function") localImageSnapshot = opts.localImageSnapshot;
  /* 全局音视频互斥锁快照（media-gen-global-lock.js 的 refreshStaleLock） */
  if (typeof opts.readMediaLock === "function") readMediaLock = opts.readMediaLock;
  if (typeof opts.locale === "function") hostLocale = opts.locale;
  /* 画布层四件事（完全替换用）：由 main.js 注入（回收站 / 画布落盘 / .mtnodes 物化都要
     DATA() 与资产目录，只有主进程知道那些落点）。缺省是上面那份「安全缺省」。 */
  if (isObj(opts.canvasOps)) {
    for (const k of Object.keys(canvasOps)) {
      if (typeof opts.canvasOps[k] === "function") canvasOps[k] = opts.canvasOps[k];
    }
  }
  getAppDataDirForSpeech = (id) => {
    try {
      return appDataDirOf(String(id || ""), diskKindOf(String(id || "")));
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

  /* 根目录：get / set / pick（set 与 pick 都是主进程写 config.json，渲染层不管路径）。
     **两套根**：kind = "down"（下载根，老键名 apps.installDir）/ "dev"（项目根，apps.projectDir）；
     不给 kind 一律按下载根走（老调用点 / 老渲染层逐字不变）。 */
  /* ── 应用版本合并（对方那一版 → 我本机开发中的那一支）────────────────────────────
     口径与产物见 app-branch-merge.js 的文件头（用户本轮共识）：合并不再是脚本式 / 类 git 的
     行级合并 —— 主进程只**拉取那一版到暂存目录 + 合并前整目录备份 + 比一份文件级差异清单**，
     然后把差异交给 Agent（新建一条会话、内置技能 mtnode-app-merge + mtnode-grill-me 拷问，
     由 Agent 直接改开发目录）；合并**不修改版本号**（每位作者各算各的），app.json 只由
     mergeNote 补一条 merges 留痕；Agent 用 .merge-done.json 宣布结束后主进程才清暂存。
     **绝不自动上架**。依赖在这里注入（这些实现都定义在本文件里）。 */
  const branchMerge = createBranchMerge({
    t: (s) => t(s),
    appRootOf: (kind) => String(rootPathOf(kind).root || ""),
    dataDir: () => String(getDataDir() || ""),
    /* 暂存根（合并用）：优先落在**数据目录**下的 runtime-tmp（与「用户数据不落应用
       文件夹」同一条口径），拿不到数据目录才退系统临时目录。 */
    tmpRoot: () => {
      const d = String(getDataDir() || "");
      const root = d ? path.join(d, "runtime-tmp") : path.join(require("os").tmpdir(), "mtnode-apps");
      mk(root);
      return root;
    },
    findSpecHit: (id, ownerId) => findSpecHit(id, ownerId),
    zipUrlsOf: (spec) => zipUrlsOf(spec),
    fetchBuffer: (url, onProgress) => fetchBuffer(url, onProgress),
    sha256: (buf) => sha256(buf),
    unzipBuffer: (buf, dest) => unzipBuffer(buf, dest),
    rmDirRecursive: (dir) => rmDirRecursive(dir),
    mk: (p) => mk(p),
    readJson: (p, fb) => readJson(p, fb),
    writeJson: (p, obj) => writeJson(p, obj),
    readManifest: (dir) => readManifest(dir),
  });
  /* 画布层四件事（回收站 / 画布落盘 / .mtnodes 物化）的安全缺省：没注入时一律回
     画布层未就绪 —— 完全替换是整目录删除，宁可不做也不能在缺注入时删掉东西。 */
  const noCanvasOps = () => ({ ok: false, error: t("画布层未就绪（请重启 MTNode）"), code: "canvas_unavailable" });
  const canvasOps = {
    canvasInfo: () => null,
    wipeCanvas: noCanvasOps,
    prepareCanvas: noCanvasOps,
    emptyCanvas: () => null,
    writeCanvas: noCanvasOps,
  };
  /* ── 应用版本「完全替换」（本轮需求 · 用户共识）─────────────────────────────────
     与合并并列的第二条路，区别只有一处：**不经过 Agent**。口径见 app-branch-replace.js
     文件头（删什么 / 留什么 / 退路 / 新画布 / 登记）。这里只注入本文件的实现 + main.js
     注入的画布层四件事（canvasInfo / wipeCanvas / prepareCanvas / emptyCanvas / writeCanvas）。 */
  const branchReplace = createBranchReplace({
    t: (s) => t(s),
    dataDir: () => String(getDataDir() || ""),
    /* 与合并同一处暂存根：只认合并拉下来的暂存目录（merge.json 认这个 appId）。 */
    stagingRoot: () => branchMerge.stagingRoot(),
    metaName: "merge.json",
    devInfo: (id) => branchMerge.devInfoFor(id),
    rmDirRecursive: (dir) => rmDirRecursive(dir),
    readManifest: (dir) => readManifest(dir),
    writeJson: (p, obj) => writeJson(p, obj),
    canvasInfo: (id) => canvasOps.canvasInfo(id),
    wipeCanvas: (id) => canvasOps.wipeCanvas(id),
    prepareCanvas: (id, srcDir, name) => canvasOps.prepareCanvas(id, srcDir, name),
    emptyCanvas: (id, name) => canvasOps.emptyCanvas(id, name),
    writeCanvas: (id, wf) => canvasOps.writeCanvas(id, wf),
  });
  /* ── 完全替换的执行体（IPC 那段只是壳）：关窗 → 干跑守卫 → 执行 → 通知画布层刷新 ──
     干跑守卫（dialog:false）是**按用户口径先做一遍前置检查**：这个应用在不在本机开发目录、
     暂存目录对不对得上、对方包在不在；任何一条不成立就什么都不动、如实回错误码。 */
  async function replaceAppWithBranch(arg) {
    const a = isObj(arg) ? arg : {};
    const id = String(a.id || "").trim();
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    if (installing[id]) return bad(t("该应用已有安装任务在跑"), "busy");
    if (a.dialog === false) {
      const local = branchMerge.devInfoFor(id);
      if (!local || local.ok === false) return local || bad(t("读不到本机开发目录"), "not_dev_app");
      if (!local.dev) return bad(t("这个应用不在本机开发目录里"), "not_dev_app");
      const staging = String(a.staging || "").trim();
      const sroot = path.resolve(String(branchMerge.stagingRoot() || ""));
      const abs = path.resolve(staging);
      if (!staging || !sroot || abs.indexOf(sroot + path.sep) !== 0) {
        return bad(t("暂存目录不在合并暂存根下（拒绝替换）"), "bad_staging");
      }
      if (!fs.existsSync(path.join(abs, "merge.json"))) {
        return bad(t("这次替换没有对应的暂存目录（先重新拉取一次）"), "staging_mismatch");
      }
      return { ok: true, dryRun: true, appId: id, dir: local.dir, myVersion: String(local.version || "") };
    }
    /* ① 关窗：先请那个应用的窗口退出（文件被占会删不掉）；关不干净就中止，什么都不动 */
    let windowClosed = false;
    if (isAppWindowOpen(id)) {
      closeAppWindow(id);
      windowClosed = await waitAppWindowClosed(id);
      if (!windowClosed) {
        return bad(t("那个应用的独立窗口没能关掉（可能正在忙），已中止替换：请先手动关掉它再试"), "window_busy");
      }
    }
    installing[id] = true;
    sendProgress({ id: id, phase: "start", percent: 0 });
    let r = null;
    try {
      r = await branchReplace.replaceWithBranch(Object.assign({}, a, { id: id, windowClosed: windowClosed }));
    } finally {
      installing[id] = false;
      sendProgress({ id: id, phase: "done", percent: 100 });
    }
    if (r && r.ok) {
      /* 画布被整份换了：主窗口若正开着这个应用的画布，内存里那份已经是旧的（再一保存就会
         把新画布盖回旧内容）—— 推一条事件让渲染层自己重载（见 app-apps.js 的订阅）。 */
      try {
        const w = getMainWin && getMainWin();
        if (w && !w.isDestroyed()) {
          w.webContents.send("apps:replaced", {
            id: id,
            wfId: id,
            nodeIds: (((r.canvas || {}).nodeIds) || []).slice(0, 500),
            version: String(r.version || ""),
            canvas: String((r.canvas && r.canvas.kind) || ""),
          });
        }
      } catch {}
    }
    return r;
  }

  /* 这个应用在不在本机开发目录（渲染层据此决定分支树上露不露合并入口；pending = 上次留下的暂存） */
  ipcMain.handle("apps:mergeInfo", guard((e, arg) => branchMerge.devInfo(isObj(arg) ? arg.id : arg)));
  /* 拉取：对方那一版 → 暂存目录 + 整目录备份 + 文件级差异清单（**不写开发目录**）。
     回执里只有文件名与计数，不带正文。 */
  ipcMain.handle("apps:mergePull", async (e, arg) => {
    try {
      const a = isObj(arg) ? arg : {};
      const r = await branchMerge.mergePull(a);
      if (!r || r.ok === false) return r;
      /* 挂看门狗：Agent 写了结束声明（.merge-done.json）就落 app.json 留痕 + 清暂存，
         并通知界面解禁入口。会话自己开在渲染层（它才知道会话 id）。 */
      branchMerge.watchStaging(r.appId, r.staging, (done) => {
        try {
          const w = getMainWin && getMainWin();
          if (w && !w.isDestroyed()) w.webContents.send("apps:mergeDone", done);
        } catch {}
      });
      return r;
    } catch (err) {
      return fail(err);
    }
  });
  /* app.json 的唯一写者：补一条 merges 留痕（版本号默认不动，只有会话里选过才跟着动） */
  ipcMain.handle("apps:mergeNote", guard((e, arg) => branchMerge.mergeNote(isObj(arg) ? arg : {})));
  /* 收尾检查：Agent 宣布结束才落留痕 + 删暂存；没宣布就什么都不做（暂存留着，下次拉取时清） */
  ipcMain.handle("apps:mergeEnd", guard((e, arg) => branchMerge.mergeEnd(isObj(arg) ? arg : {})));
  ipcMain.handle("apps:replaceInfo", guard((e, arg) => {
    const a = isObj(arg) ? arg : {};
    const id = String((isObj(arg) ? a.id : arg) || "").trim();
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    const local = branchMerge.devInfoFor(id);
    if (!local || local.ok === false) return local || bad(t("读不到本机开发目录"), "not_dev_app");
    if (!local.dev) return { ok: true, dev: false, dir: "", myVersion: "", pending: null };
    const staging = String(a.staging || (local.pending && local.pending.staging) || "");
    /* 用户口径：这一步要**说清要删什么**，所以把本机这一份的现状一并回报（界面用来写后果）；
       数据文件「保留」那一档也写在回执里 —— 完全替换的口径只在一处：app-branch-replace.js
       的文件头 + 这里这两行（界面照它写文案，不自己另立一份说明）。 */
    return {
      ok: true,
      dev: true,
      dir: String(local.dir || ""),
      myVersion: String(local.version || ""),
      staging: staging,
      pending: local.pending || null,
      keeps: ["apps-data"],
      deletes: ["app-dir", "canvas", "merge-leftovers"],
      appWindowOpen: isAppWindowOpen(id),
    };
  }));  /* **完全替换**（本轮需求）：删本机旧版本（应用目录 + 开发画布）+ 铺对方那一版 + 接续开发，
     全程不建会话、不经过 Agent。前置：这个应用先在**本机开发目录**里（dev），且暂存目录是
     合并那条路拉的（merge.json 认这个 appId）。顺序见下面那段注释。 */
  ipcMain.handle("apps:replaceWithBranch", async (e, arg) => {
    try {
      return await replaceAppWithBranch(isObj(arg) ? arg : {});
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("apps:rootGet", guard((e, arg) => {
    const roots = rootsInfo();
    const k = kindOfRoot(isObj(arg) ? arg.kind : arg);
    const one = roots[k] || {};
    return Object.assign({}, one, { roots: roots });
  }));
  ipcMain.handle("apps:rootSet", guard((e, arg) => {
    const o = isObj(arg) ? arg : { path: arg };
    return setRoot(o.path, o.kind);
  }));
  ipcMain.handle("apps:rootPick", async (e, arg) => {
    try {
      const o = isObj(arg) ? arg : {};
      const r = await pickRoot(o.kind);
      if (!r.ok) return r;
      return Object.assign({}, r, { list: listApps() });
    } catch (err) {
      return fail(err);
    }
  });
  /* 旧布局搬家（**显式入口**，用户口径：不自动迁移）：dryRun=true 只回一份「会动哪些目录」的清单 */
  ipcMain.handle("apps:migrateLayout", guard((e, arg) =>
    migrateAppsLayout(isObj(arg) ? arg : {}),
  ));

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
  /* 云端条目元数据 → 本机**所有**同 id 副本（两套根都扫；见 syncCloudMetaToLocal 头部）。
     与 apps:setMeta 是两条独立通道，语义不重叠：这一条只写 title / description / tags。 */
  ipcMain.handle("apps:syncCloudMeta", guard((e, arg) => syncCloudMetaToLocal(arg)));
  /* 应用能力位（app.json 的 capabilities）：文字输入 / 图像生成 —— 卡片小标、脚手架起步文件、
     宿主听写条注入都读它。设 textInput 时按模板重生成入口页（与「换风格」同一口径）。 */
  ipcMain.handle("apps:capabilitiesGet", guard((e, arg) => appCapabilitiesGet(arg)));
  ipcMain.handle("apps:capabilitiesSet", guard((e, arg) => appCapabilitiesSet(arg)));
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
      const o = isObj(arg) ? arg : { id: arg };
      return await uninstallApp(o.id, o);
    } catch (err) {
      return fail(err);
    }
  });
  /* 本机多版本（§九）：versions = 只读台账（当前版 + 上一版，回滚入口据此显隐）；
     rollback = 把目标那一版按台账来源重新下载并换进来（进度仍走 apps:progress）。 */
  ipcMain.handle("apps:versions", guard((e, arg) => appsVersionPick(isObj(arg) ? arg.id : arg, isObj(arg) ? arg.kind : "")));
  ipcMain.handle("apps:rollback", async (e, arg) => {
    try {
      return await rollbackApp(arg);
    } catch (err) {
      return fail(err);
    }
  });
  /* 上架（§七）：拍应用自己的窗口 + 现打包读回 base64（上架窗只拿回执，不碰文件系统）。
     **不再暴露 apps:exportZip**：上架只打一趟包（apps:readZipBase64），本机「导出 zip」那条
     界面入口早已下线，留着就是一只没人调的桥（exportZip 本身仍是打包唯一实现，内部照用）。 */
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

  ipcMain.handle("apps:openWindow", guard((e, arg) => openAppWindow(isObj(arg) ? arg.id : arg, isObj(arg) ? arg.kind : "")));
  /* 按 id 关掉某个应用的独立窗口（主窗口侧也能关）：开发页那条「预览因独立窗口已开而只读」
     的提示旁边那颗「关掉独立窗口」用它 —— 不然用户得自己切到库页去找那个窗口。
     走的还是同一条「先请应用收尾、再关」的链（closeAppWindow）。 */
  ipcMain.handle("apps:closeAppWindow", guard((e, arg) => {
    const id = safeAppId(isObj(arg) ? arg.id : arg);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    const closed = closeAppWindow(id);
    return { ok: true, id: id, closed: !!closed };
  }));
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
  /* 图像生成（流式 + 可取消 + 可带参考图）：事件走 apps:hostStream（type:"progress"）。
     与 hostTextStream 同一个通道，应用侧按 reqId 分流。 */
  ipcMain.handle("apps:hostImageStream", async (e, arg) => {
    try {
      return await hostImageStream(e, arg);
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle("apps:hostImageCancel", guard((e, arg) => hostImageCancel(e, arg)));
  /* 显式图生图 / 图像编辑（参考图必填）：与 hostImageStream 同一份实现，事件同样走 apps:hostStream */
  ipcMain.handle("apps:hostImageEdit", async (e, arg) => {
    try {
      return await hostImageEdit(e, arg);
    } catch (err) {
      return fail(err);
    }
  });
  /* 图像后端清单与选择（与文字模型那套同构：默认 auto + 按应用 id 持久化） */
  ipcMain.handle("apps:hostImageModels", guard((e, arg) => imageModelsPayload(e, arg)));
  ipcMain.handle("apps:hostImageModel", guard((e, arg) => hostImageModelGet(e, arg)));
  ipcMain.handle("apps:hostImageSetModel", guard((e, arg) => hostImageModelSet(e, arg)));
  /* 模型继承（列清单 / 读选择 / 改选择）：应用窗口不能在已配置清单之外挑模型，
     服务商与 Key 一律不回传（见 hostModelsPayload 一节）。 */
  ipcMain.handle("apps:hostModels", guard((e) => hostModelsPayload(e)));
  /* 应用自报能力位：preload 据此决定要不要注入听写条（没声明 = 不注入） */
  ipcMain.handle("apps:hostCapabilities", guard((e, arg) => hostCapabilities(e, arg)));
  ipcMain.handle("apps:hostModel", guard((e, arg) => hostModelGet(e, arg)));
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
  ipcMain.handle("apps:hostStorageAll", guard((e, arg) => hostStorageAll(e, arg)));
  ipcMain.handle("apps:hostStorageRemove", guard((e, arg) => hostStorageRemove(e, arg)));
  ipcMain.handle("apps:hostAccount", guard((e, arg) => hostAccount(e, arg)));
  /* 数据落盘（默认数据根 / 可改的数据文件夹）+ 关窗收尾回包 */
  ipcMain.handle("apps:hostDataDirGet", guard((e, arg) => hostDataDirGet(e, arg)));
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
  ipcMain.handle("apps:hostAsrMic", guard((e, arg) => {
    const own = senderAppDir(e, arg);
    if (!own) return bad(t("不是应用窗口"), "not_app");
    return { ok: true, mic: true, note: "getUserMedia 在应用页里直接调用（宿主已放行 media 权限）" };
  }));

  /* ── 预览态宿主桥（本轮需求：预览里也连入 MTNode）─────────────────────────────
     三条通道：登记 / 撤销预览租约、以及**一条总入口** apps:previewCall 把预览页的调用
     分派到与独立窗口**逐字同一条**宿主实现上。认应用靠租约（主窗口 + token），
     所以这里只做三件事：查表、白名单分派、把结果 / 流式帧 / 被拒通知送回主窗口。 */
  ipcMain.handle("apps:previewRegister", guard((e, arg) => registerPreviewLease(e, arg)));
  ipcMain.handle("apps:previewRelease", guard((e, arg) => releasePreviewLease(e, arg)));
  /* 预览桥的现况（开发页状态行：当前租约 + 是不是只读） */
  ipcMain.handle("apps:previewState", guard(() => previewLeaseState()));
  ipcMain.handle("apps:previewCall", async (e, arg) => {
    const a = isObj(arg) ? arg : {};
    const id = previewAppIdOf(e, a);
    if (!id) return bad(t("不是预览会话"), "not_preview");
    const method = String(a.method || "");
    const val = a.arg == null ? {} : a.arg;
    const pvArg = Object.assign({}, isObj(val) ? val : { param: val }, { token: String(a.token || "") });
    try {
      switch (method) {
        case "textGenStream":
          return await hostTextStream(e, pvArg);
        case "imageGen":
          return await hostImageStream(e, pvArg);
        case "imageEdit":
          return await hostImageEdit(e, pvArg);
        case "imageGenCancel":
          return hostImageCancel(e, pvArg);
        case "hostImageModels":
          return imageModelsPayload(e, pvArg);
        case "hostImageModel":
          return hostImageModelGet(e, pvArg);
        case "hostImageSetModel":
          return hostImageModelSet(e, pvArg);
        case "hostModels":
          return hostModelsPayload(e, pvArg);
        case "hostModel":
          return hostModelGet(e, pvArg);
        case "hostSetModel":
          return hostModelSet(e, pvArg);
        case "pickImage":
          return await pickImageForApp(getMainWin());
        case "pickAudio":
          return await pickAudioForApp(e, pvArg);
        case "transcribe":
          return await hostAsrTranscribe(e, pvArg);
        case "asrStatus":
          return await hostAsrStatus(e, pvArg);
        case "asrPrepare":
          return await hostAsrPrepare(e, pvArg);
        case "asrMic":
          return { ok: true, mic: true, note: "getUserMedia 在预览页里直接调用（宿主已放行 media 权限）" };
        case "storageGet":
          return hostStorageGet(e, pvArg);
        case "storageSet":
          return hostStorageSet(e, pvArg);
        case "storageAll":
          return hostStorageAll(e, pvArg);
        case "storageRemove":
          return hostStorageRemove(e, pvArg);
        case "dataDirGet":
          return hostDataDirGet(e, pvArg);
        case "dataDirPick":
          return await hostDataDirPick(e, pvArg);
        case "dataDirOpen":
          return await hostDataDirOpen(e, pvArg);
        case "dataDirReset":
          return hostDataDirReset(e, pvArg);
        case "dataRead":
          return hostDataRead(e, pvArg);
        case "dataWrite":
          return hostDataWrite(e, pvArg);
        case "account":
          return hostAccount(e, pvArg);
        case "close":
        case "quit":
          emitPreviewNotice(id, "preview_no_window", previewNoWindowError().error);
          return previewNoWindowError();
        default:
          return bad(t("预览桥不认识这个方法：") + method, "bad_method");
      }
    } catch (err) {
      return fail(err);
    }
  });

  /* ── 应用数据（主窗口 / 应用中心侧）：只留「打开数据目录」这一件事 ──
     数据目录用 app id 管理（默认数据根 <数据目录>/apps-data/<id>/，用户改过则是他选的那个），
     入口是库 / 开发页每张卡片右侧那颗 📂；路径只由主进程解析，渲染层不拼路径、不写路径。
     改数据文件夹位置仍只在应用窗口里（preload-app.js 的 appHost.dataDir* → apps:hostDataDir*）。 */
  ipcMain.handle("apps:dataOpen", async (e, arg) => {
    try {
      const o = isObj(arg) ? arg : { id: arg };
      const id = safeAppId(o.id);
      if (!id) return bad(t("应用 id 不合法"), "bad_id");
      return await openAppDataDir(id, o.kind);
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
  /* 云端条目元数据同步（title / description / tags → 本机所有同 id 副本）：纯函数段 + 真文件读写，
     冒烟用临时目录直接真跑（见 test/smoke-apps-sync-meta.js） */
  syncCloudMetaToLocal,
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
  /* 本机多版本（docs/apps-market.md §九）：台账查询 + 按来源重下的回滚。纯函数段为主，
     冒烟直接真跑（载荷不落盘，所以回滚必须真的走一次下载 + sha256 校验）。 */
  appsVersionPick,
  rollbackApp,
  /* 打包实现（导出 zip 与上架包共用一份：真读目录 + 真跑上架口径，冒烟直接真跑） */
  packEntriesOf,
  /* 目录双源（静态目录 / 云端接口）：解析与来源判定是纯函数段，冒烟直接真跑 */
  parseCatalogDoc,
  /* 「云端答了 0 条」的失败码（loadCatalog 靠它记 answered，渲染层靠答案决定说不说「无法连接」） */
  emptyCatalogErr,
  isEmptyCatalogErr,
  emptyCatalogResult,
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
  /* 应用侧图像通道（冒烟直接真跑）：云端清单按模型形态认、本机后端按注入的探测函数认 */
  listCloudImageModels,
  usableImageProviders,
  resolveImagePick,
  readImageSelection,
  writeImageSelection,
  imageModelsPayload,
  imageBackendsForUi,
  localImageBackend,
  hostImageModelGet,
  hostImageModelSet,
  hostImageStream,
  hostImageEdit,
  hostImage,
  hostImageCancel,
  imageRefDataUrls,
  strengthOf,
  imgCfgScaleOf,
  cloudImageCaps,
  hostImageGenerate,
  generateLocalImage,
  imageSpec,
  LOCAL_MAX_REF_IMAGES,
  LOCAL_IMAGE_PROVIDER_ID,
  /* 应用能力位（app.json 的 capabilities）：主进程两条入口真跑 + 默认页注入口径 */
  appCapabilitiesGet,
  appCapabilitiesSet,
  defaultPageHtml,
  normCapabilities,
  capabilityOn,
  capabilityBadges,
  capabilitiesForUi,
  syncSpeechFiles,
  /* 两套根（下载 / 开发）与它们的数据目录：冒烟与迁移直接真跑这几个 */
  APP_KIND_DOWN,
  APP_KIND_DEV,
  APP_KINDS,
  kindOfRoot,
  kindLabel,
  rootPathOf,
  rootsInfo,
  dirOfKind,
  dirOfApp,
  diskKindOf,
  kindOfManifest,
  appDataRootPath,
  legacyDataRoot,
  migrateAppsLayout,
  /* 默认根的固化（本轮需求：不再要求手动指定）：冒烟直接真跑它 */
  ensureRootPersisted,
  unregisterApp,
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

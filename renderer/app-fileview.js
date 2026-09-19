"use strict";
/* ============================================================
 * 会话工具条「被读 / 被改的文件」识别 + 多语言文件高亮
 * （渲染层 · 纯自研，零第三方依赖 · 本段完全不碰 DOM）
 * ------------------------------------------------------------
 * 这一段只吃字符串、只吐字符串，所以 test/ 下的冒烟脚本能直接把它切片真跑，
 * 不需要假 DOM：
 *   · toolFileRefs(t)               工具调用记录 {name,args} → 它触及的文件
 *                                   [{ path, name, mode:'read'|'write'|'dir', line, count }]
 *   · toolFileRefsAbs(t, baseWs)    同一份 + 按会话工作区补全 abs
 *   · resolveToolPath(p, baseWs)    相对路径 → 生效工作区下的绝对路径（纯词法归一）
 *   · fileviewLangOf(path)          扩展名 → 语言 id（认不出返回 ""）
 *   · fileviewIsImagePath(path)     是否图片扩展名
 *   · fileviewBaseName / fileviewExtOf   路径拆名（徽标正文与面板头部共用）
 *   · fileviewPathIsOpenable(p)     是否「能直接喂给 fileStat / fileReadText」的绝对路径
 *   · fileviewHighlight(code, lang) 代码 → <span class="jsl-*"> 高亮 HTML
 *
 * 为什么不引 highlight.js / Monaco / CodeMirror：会话里真出现的文件类型有限，
 * js / py / css / html / yaml / md / sh / ini 这几个就覆盖九成。自研一份通用词法
 * 换来零包体、零额外 CSP 放通，配色还完全跟随主题 —— token class 直接复用
 * css/canvas.css 里 jsHighlightHtml 那一套 .jsl-*，亮色在 theme-light.css 已有逐条覆盖。
 *
 * 同源优先：js / ts / json 交给 app-codeedit.js 的 jsHighlightHtml（与函数节点
 * 编辑器词法同源，同一个 .js 在节点里和在面板里长得一模一样），yaml 交给 app.js 的
 * highlightYamlLine（与 YAML 编辑器同源）。两者都用 typeof 探测，单独切本片跑时
 * 自动退回本文件的通用词法，不会因此炸。
 *
 * 转义口径与 app.js escapePromptHl / app-codeedit.js codeEditEscape 一致（只放 & < >）：
 * 正文里的尖括号永远只是文字，不可能变成标签。
 *
 * 第二段（本文件后半）才是 DOM：右侧贴边的查看面板 openFilePeek / closeFilePeek，
 * 样式在 css/fileview.css（.fp-* 一套，token 配色直接复用 .jsl-*）。
 * 面板默认只「看」；文本文件另给一个显式「编辑」态（行号槽 + 高亮镜像层 + 透明输入框 + 保存 + 撤销重做）：
 *   · 进编辑态才会写盘，且保存前比一眼 mtime —— 期间别的程序（或 Agent）改过就先问一句；
 *   · 换文件 / 重读 / 收起面板前只要有未保存改动，一律先确认，绝不默默丢用户的字；
 *   · 编辑态与只读代码视图共用同一套 CSS 与同一份字体度量：高亮镜像层在下、输入框在上
 *     （文字透明只留光标），所以进编辑不会丢着色，也不再有两层错位漂光标那回事。
 * ============================================================ */

/* ============================================================
 * 一、从工具调用参数里认出文件
 * ============================================================ */

/* 会被当成「一个文件」的参数名，顺序即徽标输出顺序。真源是 dsh 各工具自己的参数表：
 * read / write / edit / read_image 用 file_path，grep / glob / str_replace_editor 用 path。 */
const FV_FILE_KEYS = ["file_path", "notebook_path", "filePath", "file", "path"];
const FV_LIST_KEYS = ["file_paths", "image_paths", "imagePaths", "paths"];

/* 带路径形状但不是「某个文件」的参数名：pwsh 的 workdir 是「命令在哪个目录跑」，
 * grep / glob 的 include 是过滤式，str_replace_editor 的 file_text 是正文……一律不显示。
 * （glob / grep 的 path 走 mode=dir 单独定性，不列在这儿。） */
const FV_NOT_FILE_KEYS = [
  "workdir", "cwd", "base_dir", "directory", "include", "pattern", "query",
  "command", "cmd", "content", "file_text", "text", "prompt", "message",
  "description", "old_string", "new_string", "new_str", "objective", "savePath",
];

const FV_READ_TOOLS = [
  "read", "read_image", "read_file", "view", "view_file", "open_file", "cat", "notebook_read",
];
const FV_WRITE_TOOLS = [
  "write", "edit", "str_replace_editor", "write_file", "create_file", "edit_file", "multi_edit",
  "search_replace", "apply_patch", "patch", "notebook_edit", "delete_file", "move_file",
  "rename_file", "insert_text_file",
];
/* 只做检索 / 列目录的工具：它的 path 是「在哪儿搜」，不是某个文件 */
const FV_DIR_TOOLS = [
  "glob", "grep", "rg", "list_dir", "list_files", "ls", "find_files", "search_files", "search",
];

/* str_replace_editor 一个工具管四件事，mode 由 command 决定，不由工具名决定 */
const FV_CMD_MODE = { view: "read", create: "write", str_replace: "write", insert: "write", undo: "write" };

const FV_SET = (arr) => new Set(arr);
const FV_READ_SET = FV_SET(FV_READ_TOOLS);
const FV_WRITE_SET = FV_SET(FV_WRITE_TOOLS);
const FV_DIR_SET = FV_SET(FV_DIR_TOOLS);
const FV_CLASSIFY_SETS = [FV_WRITE_SET, FV_DIR_SET, FV_READ_SET];

/* 工具名归一：真名可能是 read，也可能是 fs.read / mcp__fs__read / dsh_read / mtnode_db。
 * 先整名比对，再按 . : / 与 __ 切段取各段（下划线整体切不得：str_replace_editor 会被切碎），
 * 最后剥一层已知前缀。都对不上就不猜，按「读」定性。 */
function fvToolNames(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return [];
  const out = [lower];
  for (const seg of lower.split(/[.:/]|__|\|\|/)) if (seg) out.push(seg);
  for (const p of ["mtnode_", "dsh_", "fs_", "file_", "tool_", "builtin_"]) {
    if (lower.startsWith(p)) out.push(lower.slice(p.length));
  }
  return Array.from(new Set(out));
}

function fvModeOfTool(name, args) {
  const cmd = args && typeof args.command === "string" ? args.command.trim().toLowerCase() : "";
  if (cmd && Object.prototype.hasOwnProperty.call(FV_CMD_MODE, cmd)) return FV_CMD_MODE[cmd];
  for (const cand of fvToolNames(name)) {
    for (const set of FV_CLASSIFY_SETS) {
      if (set.has(cand)) return set === FV_WRITE_SET ? "write" : set === FV_DIR_SET ? "dir" : "read";
    }
  }
  return "read"; /* 认不出来时按「读」定性：那是识别度最低、最保守的一种徽标 */
}

function fvIsAbsoluteish(p) {
  const s = String(p || "");
  return (
    /^[A-Za-z]:[\\/]/.test(s) || /* Windows 盘符 */
    s.startsWith("\\\\") || /* UNC */
    s.startsWith("/") || /* POSIX */
    s.startsWith("~/") || s.startsWith("~\\")
  );
}

/* 文件名（最后一段）；两种斜杠都认，尾部多余分隔符先吃掉 */
function fileviewBaseName(p) {
  const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
  if (!s) return "";
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i < 0 ? s : s.slice(i + 1);
}

/* 小写扩展名；".gitignore" 这种「整段就是名字」的文件返回 "" */
function fileviewExtOf(p) {
  const base = fileviewBaseName(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

/* 纯字符串层面的归一：统一分隔符（盘符 / UNC 用 \，POSIX 用 /）、吃掉 "."、
 * 就地解 ".."、去掉重复分隔符。不碰文件系统 —— 不 stat、不解析符号链接、不校验存在。 */
function fvNormalizePath(p) {
  let s = String(p == null ? "" : p).trim();
  if (!s) return "";
  const fu = /^file:\/\/\/([A-Za-z]:[\\/][^?#]*)/i.exec(s); /* file:///E:/a/b → E:/a/b */
  if (fu) s = fu[1];
  else if (/^file:\/\//i.test(s)) return s; /* 非本地 file URL 原样交给下游 */
  const drive = /^([A-Za-z]):/.exec(s);
  const isUnc = !drive && /^\\{2}[^\\]/.test(s);
  const isPosix = !drive && !isUnc && (s.startsWith("/") || s.startsWith("\\"));
  const body = drive ? s.slice(2) : isUnc ? s.slice(2) : isPosix ? s.slice(1) : s;
  const segs = [];
  for (const g of String(body).split(/[\\/]+/)) {
    if (!g || g === ".") continue;
    if (g !== "..") {
      segs.push(g);
      continue;
    }
    if (segs.length && segs[segs.length - 1] !== "..") segs.pop();
    else segs.push("..");
  }
  if (drive) return drive[1] + ":\\" + segs.join("\\");
  if (isUnc) return "\\\\" + segs.join("\\");
  if (isPosix) return "/" + segs.join("/");
  return segs.join("\\") || ".";
}

/* 相对路径 → 该会话生效工作区下的绝对路径。
 * baseWs 必须由调用方现取（会话 agentRunWorkspace(st) / 助手 assistResolveWorkspace() /
 * 节点 dshWorkspaceOf(node) 三个真源之一），本函数绝不自己拼一个默认目录出来。
 * 没有基准时：绝对路径照旧归一，相对路径原样归一返回（调用方据此「只显文件名、不开面板」）。 */
function resolveToolPath(p, baseWs) {
  const raw = String(p == null ? "" : p).trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!raw) return "";
  if (fvIsAbsoluteish(raw)) return fvNormalizePath(raw);
  const base = String(baseWs == null ? "" : baseWs).trim().replace(/[\\/]+$/, "");
  if (!base) return fvNormalizePath(raw);
  if (/^file:\/\//i.test(raw)) return raw;
  const sep = /^[A-Za-z]:[\\/]/.test(base) || base.indexOf("\\") >= 0 ? "\\" : "/";
  return fvNormalizePath(base + sep + raw.replace(/^[\\/]+/, ""));
}

/* 徽标 / 面板拿去判断「这个路径能不能直接喂给 fileStat / fileReadText」：
 * 只有绝对路径能开。会话没解析出生效工作区时 abs 仍是相对的 → 只显文件名、不给点开面板。 */
function fileviewPathIsOpenable(p) {
  const s = String(p == null ? "" : p).trim();
  return !!s && (fvIsAbsoluteish(s) || /^file:\/\/[A-Za-z]:[\\/]/i.test(s));
}

/* t.args 的真实形状有三种：DSH 原样透传的 arguments JSON 串（最常见，且可能被截断）、
 * 宿主插件（tools-plugin / canvas-plugin）直接给的 object、老记录里的空串。
 * 统一解成 { obj, partial, raw }：partial = 有正文但不是合法 JSON → 交给正则兜底。 */
function fvParseToolArgs(t) {
  const a = t && t.args;
  if (a && typeof a === "object") return { obj: a, partial: false, raw: "" };
  const raw = typeof a === "string" ? a : "";
  if (!raw.trim()) return { obj: null, partial: false, raw };
  try {
    const o = JSON.parse(raw);
    return { obj: o && typeof o === "object" ? o : null, partial: false, raw };
  } catch {
    return { obj: null, partial: true, raw };
  }
}

function fvJsonUnescape(s) {
  try {
    return JSON.parse('"' + String(s) + '"');
  } catch {
    return String(s).replace(/\\(.)/g, "$1");
  }
}

/* 兜底：从「不是合法 JSON」的参数串里抠 "key":"value" / "key":123。
 * 值里带转义引号也吃得下（\\.|[^"\\] 那条分支），末尾被截断的键自然吃不到。 */
function fvRegexPick(str, key, kind) {
  const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re =
    kind === "num"
      ? new RegExp('"' + esc + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)', "g")
      : new RegExp('"' + esc + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"', "g");
  const out = [];
  let m;
  while ((m = re.exec(String(str || "")))) out.push(kind === "num" ? Number(m[1]) : fvJsonUnescape(m[1]));
  return out;
}

function fvNumOf(args, key, raw, partial) {
  if (args && args[key] != null && args[key] !== "" && Number.isFinite(Number(args[key]))) {
    return Number(args[key]);
  }
  if (partial) {
    const got = fvRegexPick(raw, key, "num");
    if (got.length && Number.isFinite(got[0])) return got[0];
  }
  return undefined;
}

/* 值长得像路径才收：绝对路径 / 带分隔符 / 有扩展名 / 是常见无扩展名文件（Dockerfile…）。
 * dirMode（glob / grep 这类检索工具）另放宽一档：光一个目录名（"renderer"、"src"）也收。 */
function fvLooksLikePathValue(s, dirMode) {
  const v = String(s == null ? "" : s).trim();
  if (!v) return false;
  if (/[\r\n]/.test(v)) return false; /* 多行一定是正文 */
  if (/\{\{|\}\}/.test(v)) return false; /* 模板残留 */
  if (/^https?:\/\//i.test(v)) return false; /* 网络地址交给浏览器，不进文件面板 */
  if (/^file:\/\//i.test(v)) return /[A-Za-z]:[\\/]/i.test(v); /* 只收本地 file URL */
  if (/[|<>*?"`]/.test(v)) return false; /* 命令行片段 / glob 表达式，不是路径 */
  /* 空格只允许出现在「确实是个路径」的值里（绝对路径，或带分隔符 / 带扩展名的名字）：
   * 参数值里塞进一句英文（"the file path"）不该被当成文件 */
  if (/[ \t]/.test(v) && !fvIsAbsoluteish(v) && !/[\\/]/.test(v) && !fileviewExtOf(v)) return false;
  const base = fileviewBaseName(v);
  if (!base) return false;
  if (/[\\/]/.test(v) || fvIsAbsoluteish(v)) return true;
  if (dirMode) return !/[^A-Za-z0-9_$.\-]/.test(v);
  return !!fileviewExtOf(base) || Object.prototype.hasOwnProperty.call(FV_NAME_LANG, base.toUpperCase());
}

/* 主入口：一条工具调用记录（{name, args}）→ 它碰过的文件清单（可能为空数组）。
 * 刻意不解析 pwsh / bash 命令行里的文件名：误报率太高，宁可少显示也不显示错的。
 * 注意：这里只出「参数里写了什么」，补全绝对路径交给 toolFileRefsAbs / resolveToolPath。 */
function toolFileRefs(t) {
  const name = String((t && t.name) || "");
  if (!name) return [];
  const parsed = fvParseToolArgs(t);
  const args = parsed.obj;
  /* 计划面板那份 args 是截断过的字符串（解不成 object），command 也得靠正则抠出来：
     否则 str_replace_editor 的 view 会被工具名兜成「改」，把只读那一步标成写。 */
  const cmdOnly = !args && parsed.partial ? fvRegexPick(parsed.raw, "command", "str")[0] : null;
  const mode = fvModeOfTool(name, args || (cmdOnly ? { command: cmdOnly } : null));
  const line = fvNumOf(args, "offset", parsed.raw, parsed.partial);
  const count = fvNumOf(args, "limit", parsed.raw, parsed.partial);
  const refs = [];
  const seen = Object.create(null);

  const push = (v, prefer) => {
    if (typeof v !== "string") return;
    const s = String(v).trim();
    if (!fvLooksLikePathValue(s, mode === "dir")) return;
    const key = mode + "|" + s.toLowerCase().replace(/[\\/]+$/, "");
    if (seen[key]) return;
    seen[key] = 1;
    refs.push({
      path: s,
      name: fileviewBaseName(s) || s,
      mode: mode,
      /* read 的 offset / limit 记成 line / count：点徽标时直接滚到那一段 */
      line: prefer && typeof line === "number" && line > 0 ? line : undefined,
      count: prefer && typeof count === "number" && count > 0 ? count : undefined,
    });
  };

  if (args) {
    let first = true;
    for (const key of FV_FILE_KEYS) {
      if (FV_NOT_FILE_KEYS.indexOf(key) >= 0) continue;
      if (typeof args[key] !== "string") continue;
      push(args[key], first);
      first = false;
    }
    for (const key of FV_LIST_KEYS) {
      if (FV_NOT_FILE_KEYS.indexOf(key) >= 0 || !Array.isArray(args[key])) continue;
      for (const v of args[key]) push(v, false);
    }
  } else if (parsed.raw) {
    /* 参数串没解成 object（多半是被截断的长正文）：按 key 逐个抠，行号只给第一条 */
    let first = true;
    for (const key of FV_FILE_KEYS) {
      if (FV_NOT_FILE_KEYS.indexOf(key) >= 0) continue;
      for (const v of fvRegexPick(parsed.raw, key, "str")) {
        push(v, first);
        first = false;
      }
    }
  }
  return refs;
}

/* 徽标 / 面板真正要的形态：同一份 toolFileRefs + 按会话工作区补全 abs。
 * 基准解析不出来时 abs 就是归一后的原始（相对）路径，调用方据此只显文件名、不开面板。 */
function toolFileRefsAbs(t, baseWs) {
  const refs = toolFileRefs(t);
  for (const r of refs) r.abs = resolveToolPath(r.path, baseWs);
  return refs;
}

/* ============================================================
 * 二、语言判定
 * ============================================================ */

/* 扩展名 → 语言 id。这个 id 既是 fileviewHighlight 的谱系键，也是面板头部显示的语言标签。
 * 认不出（含没有扩展名）返回 ""，只按纯文本转义输出 —— 宁可不配色，也不配错色。 */
const FV_EXT_LANG = {
  js: "js", mjs: "js", cjs: "js", jsx: "js",
  ts: "ts", mts: "ts", cts: "ts", tsx: "tsx",
  json: "json", jsonc: "json", jsonl: "json", ndjson: "json",
  md: "md", markdown: "md", mkd: "md",
  py: "py", pyw: "py", pyi: "py",
  css: "css", scss: "scss", sass: "scss", less: "less",
  html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html",
  xml: "xml", svg: "xml", resx: "xml", plist: "xml", dtd: "xml", xlf: "xml",
  yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", conf: "ini", cfg: "ini", properties: "ini", env: "ini",
  sh: "sh", bash: "sh", zsh: "sh", ps1: "ps1", bat: "bat", cmd: "bat",
  sql: "sql", lua: "lua",
  go: "go", rs: "rs", java: "java", kt: "kt", kts: "kt", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "cs",
  rb: "rb", php: "php",
  txt: "text", log: "text", csv: "text", tsv: "text",
  diff: "diff", patch: "diff",
};

/* 没有扩展名、但形状很固定的常见文件 */
const FV_NAME_LANG = {
  DOCKERFILE: "sh",
  MAKEFILE: "sh",
  GITIGNORE: "ini",
  GITATTRIBUTES: "ini",
  GITMODULES: "ini",
  EDITORCONFIG: "ini",
  AGENTS: "md",
  README: "md",
  CHANGELOG: "md",
  CONTRIBUTING: "md",
  LICENSE: "text",
  NOTICE: "text",
  AUTHORS: "text",
  ENV: "ini",
  XDEFAULTS: "ini",
};

const FV_IMAGE_EXT = FV_SET(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "tiff", "tif"]);

function fileviewLangOf(p) {
  const base = fileviewBaseName(p);
  if (!base) return "";
  const upper = base.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(FV_NAME_LANG, upper)) return FV_NAME_LANG[upper];
  const ext = fileviewExtOf(base);
  if (!ext) return "";
  return Object.prototype.hasOwnProperty.call(FV_EXT_LANG, ext) ? FV_EXT_LANG[ext] : "";
}

function fileviewIsImagePath(p) {
  const ext = fileviewExtOf(p);
  return !!ext && FV_IMAGE_EXT.has(ext);
}

/* ============================================================
 * 三、高亮（纯字符串 → HTML；正文一律转义，不产生标签注入）
 * ============================================================ */

/* 与 app.js escapePromptHl / app-codeedit.js codeEditEscape 同口径（只放 & < >） */
function fvEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const FV_PY_KW = FV_SET([
  "def","class","return","if","elif","else","for","while","break","continue","pass",
  "import","from","as","with","try","except","finally","raise","lambda","yield",
  "global","nonlocal","assert","del","in","is","not","and","or","async","await","match",
]);
const FV_PY_LIT = FV_SET(["True", "False", "None", "self", "cls", "print", "range", "len"]);

/* C 家族（c / cpp / cs / java / go / rs / kt / swift / php / rb / lua）共用一份：
 * 多认几个词只会让颜色更满，认不出来也只是少个色，绝不会把正文弄错。 */
const FV_C_KW = FV_SET([
  "auto","bool","break","case","catch","char","class","const","constexpr","continue",
  "decltype","default","delete","do","double","dyn","else","enum","explicit","export",
  "extends","extern","final","float","fn","for","friend","func","fun","goto","if",
  "impl","import","inline","instanceof","int","interface","let","long","match","mod",
  "mut","namespace","new","object","open","override","package","private","protected",
  "pub","public","register","return","sealed","short","sizeof","static","struct","super",
  "switch","template","this","throw","trait","transient","try","typedef","typeof","union",
  "unsafe","unsigned","use","using","val","var","virtual","void","volatile","where","while","yield",
]);
const FV_C_LIT = FV_SET([
  "true","false","null","nil","NULL","nullptr","undefined","None","Some","Ok","Err","Self",
]);

const FV_SH_KW = FV_SET([
  "if","then","else","elif","fi","for","in","do","done","while","until","case","esac",
  "function","return","exit","local","export","set","unset","shift","source","trap","wait",
  "echo","printf","read","cd","test","true","false","begin","end","foreach","switch",
  "param","throw","try","catch","finally","call","start","pushd","popd","rem",
]);

const FV_SQL_KW = FV_SET([
  "select","from","where","insert","into","values","update","set","delete","create",
  "table","index","view","drop","alter","add","column","primary","key","foreign",
  "references","join","left","right","inner","outer","full","on","as","and","or",
  "not","null","in","is","like","between","group","by","order","having","limit",
  "offset","distinct","union","all","case","when","then","else","end","exists",
  "default","unique","constraint","begin","commit","rollback","transaction","with",
]);

const FV_CSS_AT = FV_SET(["media","import","keyframes","supports","font-face","charset","page","namespace","use","layer"]);

const FV_CLIKE = { line: ["//"], block: [["/*", "*/"]], str: ['"', "'"], num: true, kw: FV_C_KW, lit: FV_C_LIT, fnParen: true };
/* js / ts 的兜底词法（正常情况下走 jsHighlightHtml，这里只在它没加载时顶上）：
 * 比 C 家族多一个可以跨行的反引号模板串 */
const FV_JSLIKE = { line: ["//"], block: [["/*", "*/"]], str: ['"', "'", "`"], num: true, kw: FV_C_KW, lit: FV_C_LIT, fnParen: true };
const FV_CSSLIKE = { line: ["//"], block: [["/*", "*/"]], str: ['"', "'"], num: true, hashNum: true, dashWord: true, keyColon: true, fnParen: true, at: FV_CSS_AT };
const FV_MARKUP = { markup: true, block: [["<!--", "-->"], ["<!", ">"], ["<?", "?>"]], str: ['"', "'"], entity: true };

/* 每种语言一份词法形状：注释 / 字符串 / 数字 / 关键字 / 标签。
 * "text"（txt / log / csv）与表里没有的未知语言 → 只转义不着色；
 * "diff" 走 fvHighlightDiff 的逐行分级，"md" 走 fvHighlightMd 的行级结构，都不在这里。 */
const FV_SPECS = {
  js: FV_JSLIKE,
  ts: FV_JSLIKE,
  tsx: FV_JSLIKE,
  json: { str: ['"'], num: true, lit: FV_SET(["true", "false", "null"]), keyColon: true },
  py: { line: ["#"], triple: ['"""', "'''"], str: ['"', "'"], num: true, kw: FV_PY_KW, lit: FV_PY_LIT, fnParen: true, decorator: true },
  sh: { line: ["#", "::", "rem "], str: ['"', "'", "`"], kw: FV_SH_KW, num: true, fnParen: true, dollar: true },
  ps1: { line: ["#", "rem "], str: ['"', "'"], kw: FV_SH_KW, num: true, fnParen: true, dollar: true },
  bat: { line: ["rem ", "::", "@rem "], str: ['"'], kw: FV_SH_KW, dollar: true },
  sql: { line: ["--"], str: ['"', "'"], kw: FV_SQL_KW, num: true, ci: true },
  ini: { line: [";", "#"], str: ['"', "'"], num: true, keyEq: true, keyColon: true, section: true },
  yaml: { line: ["#"], str: ['"', "'"], num: true, keyColon: true, dashPunc: true },
  css: FV_CSSLIKE,
  scss: FV_CSSLIKE,
  less: FV_CSSLIKE,
  html: FV_MARKUP,
  xml: FV_MARKUP,
  c: FV_CLIKE,
  cpp: FV_CLIKE,
  cs: FV_CLIKE,
  java: FV_CLIKE,
  go: FV_CLIKE,
  rs: FV_CLIKE,
  kt: FV_CLIKE,
  swift: FV_CLIKE,
  php: FV_CLIKE,
  /* Go 的裸串是反引号，且没有单引号字符串（'x' 是 rune 常量，按字面量上色即可） */
  go: { line: ["//"], block: [["/*", "*/"]], str: ['"', "`"], num: true, kw: FV_C_KW, lit: FV_C_LIT, fnParen: true },
  rb: { line: ["#"], block: [["=begin", "=end"]], str: ['"', "'", "`"], num: true, kw: FV_C_KW, lit: FV_C_LIT, fnParen: true },
  lua: { line: ["--"], block: [["--[[", "]]"]], str: ['"', "'"], num: true, kw: FV_C_KW, lit: FV_C_LIT, fnParen: true },
  text: {},
  diff: { diff: true },
};

const FV_WORD_START = /[A-Za-z_$@]/;
const FV_WORD_CHAR = /[A-Za-z0-9_$]/;

/* 行首（前面只可能有缩进）判定：ini 的 [section]、sh 的 rem 只在那儿成立 */
function fvAtLineHead(s, i) {
  let k = i - 1;
  while (k >= 0 && (s[k] === " " || s[k] === "\t")) k--;
  return k < 0 || s[k] === "\n";
}

/* 标签结束位置：属性值里的 > 不算结束（<div title="a>b">），引号内整段跳过；
 * 遇到换行或另一个 < 说明这不是一个标签（正文里的裸尖括号），返回 -1 交回上层当标点。 */
function fvTagEnd(s, from) {
  const n = s.length;
  let q = "";
  for (let i = from + 1; i < n; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === ">") return i + 1;
    if (c === "<" || c === "\n") return -1;
  }
  return -1;
}

/* 标签整段内部上色：< > / = 是标点，紧跟的第一个名字用函数色，属性名用属性色，
 * 属性值用字符串色；注释 / DOCTYPE / CDATA 整段按注释。 */
function fvHighlightTag(text) {
  if (/^<[!?]/.test(text)) return '<span class="jsl-com">' + fvEsc(text) + "</span>";
  const n = text.length;
  let out = "";
  let i = 0;
  let nameDone = false;
  const emit = (cls, t) => {
    out += cls ? '<span class="jsl-' + cls + '">' + fvEsc(t) + "</span>" : fvEsc(t);
  };
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) j++;
      emit("str", text.slice(i, Math.min(n, j + 1)));
      i = j + 1;
      continue;
    }
    if (FV_WORD_START.test(c) || (c === "-" && nameDone)) {
      let j = i;
      while (j < n && (FV_WORD_CHAR.test(text[j]) || text[j] === "-" || text[j] === ":" || text[j] === ".")) j++;
      emit(nameDone ? "prop" : "fn", text.slice(i, j));
      nameDone = true;
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      emit("", text.slice(i, j));
      i = j;
      continue;
    }
    emit("punc", c);
    i++;
  }
  return out;
}

/* 通用词法扫描。跨位置的状态只有一个：openBlock（正在块注释里，闭合串没出现就一路吃到文件末尾）。
 * 每个位置依次试「块注释 → 行注释 → 三引号串 → 单行串 → 标签 → 实体 → [段落头] / @规则 / @装饰器
 * / $变量 → 色值 → 数字 → 单词 → 标点 → 空白」，命中多少推进多少；相邻同类 token 合并进同一个
 * <span>，几千行的文件也不会炸出上万个节点。class 名与 jsHighlightHtml 同一套（jsl-*）。 */
function fvHighlightGeneric(src, spec) {
  const s = String(src == null ? "" : src);
  if (!s) return "";
  const sp = spec || {};
  const n = s.length;
  let out = "";
  let buf = "";
  let bufCls = "";
  const flush = () => {
    if (!buf) {
      bufCls = "";
      return;
    }
    out += bufCls ? '<span class="jsl-' + bufCls + '">' + fvEsc(buf) + "</span>" : fvEsc(buf);
    buf = "";
    bufCls = "";
  };
  const add = (cls, text) => {
    if (!text) return;
    if (buf && bufCls !== cls) flush();
    bufCls = cls;
    buf += text;
  };
  const lineEnd = (from) => {
    const k = s.indexOf("\n", from);
    return k < 0 ? n : k;
  };

  let openBlock = ""; /* 块注释的闭合串（跨行只在「没闭合」时留状态） */
  let i = 0;

  /* 单行串：找同行闭合；闭合不了（正文里有裸引号）就在行尾收手，绝不吃到文件末尾 */
  const closeInline = (q, from) => {
    let j = from + q.length;
    while (j < n) {
      const c = s[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "\n") return -1;
      if (c === q) return j + q.length;
      j++;
    }
    return -1;
  };
  const closeMulti = (q, from) => {
    let j = from + q.length;
    while (j < n) {
      if (s[j] === "\\") {
        j += 2;
        continue;
      }
      if (s.startsWith(q, j)) return j + q.length;
      j++;
    }
    return -1;
  };

  while (i < n) {
    if (openBlock) {
      const k = s.indexOf(openBlock, i);
      const e = k < 0 ? n : k + openBlock.length;
      add("com", s.slice(i, e));
      i = e;
      openBlock = "";
      continue;
    }
    const c = s[i];

    if (/\s/.test(c)) {
      /* 空白整段吃掉（含换行）：行首判定一律回头看 fvAtLineHead，不留游标状态 */
      let j = i;
      while (j < n && /\s/.test(s[j])) j++;
      add("", s.slice(i, j));
      i = j;
      continue;
    }

    /* ── 块注释开 ── */
    let hit = false;
    for (const b of sp.block || []) {
      if (!s.startsWith(b[0], i)) continue;
      add("com", b[0]);
      i += b[0].length;
      openBlock = b[1];
      hit = true;
      break;
    }
    if (hit) continue;

    /* ── 行注释开（# 型必须行首或紧跟空白，避开 yaml 值里的 "a#b"；// 型不受限）── */
    for (const p of sp.line || []) {
      if (!s.startsWith(p, i)) continue;
      if (p.charAt(0) === "#" && i !== 0 && !/[ \t]/.test(s[i - 1])) continue;
      if (p === "rem " || p === "@rem " || p === "::") {
        if (!fvAtLineHead(s, i)) continue;
      }
      const e = lineEnd(i);
      add("com", s.slice(i, e));
      i = e;
      hit = true;
      break;
    }
    if (hit) continue;

    /* ── 字符串：三引号 / 反引号可跨行，单引号双引号只在本行内；
     *    闭合后紧跟 ":" 的就是键名（JSON / YAML / CSS 的 "key": value），换属性色 ── */
    for (const q of sp.triple || []) {
      if (!s.startsWith(q, i)) continue;
      const e = closeMulti(q, i);
      if (e < 0) {
        add("str", s.slice(i));
        i = n;
      } else {
        add("str", s.slice(i, e));
        i = e;
      }
      hit = true;
      break;
    }
    if (hit) continue;
    for (const q of sp.str || []) {
      if (c !== q) continue;
      let e = closeInline(q, i);
      let multi = false;
      if (e < 0 && q === "`") {
        e = closeMulti(q, i); /* 反引号（模板串 / sh 命令替换）允许跨行 */
        multi = e < 0;
      }
      if (e >= 0) {
        const seg = s.slice(i, e);
        const after = s.slice(e, Math.min(n, e + 6));
        /* "key": 形式（JSON / YAML / CSS 的带引号键名）换属性色；"://" 与 ":\\" 是协议与盘符，不算键 */
        add(sp.keyColon && /^[ \t]*:(?![:=\\/])/.test(after) && !multi ? "prop" : "str", seg);
        i = e;
      } else {
        add("punc", q); /* 行内闭不上（正文里的裸引号）：只当标点，不吞掉整行 */
        i++;
      }
      hit = true;
      break;
    }
    if (hit) continue;

    /* ── 标签（html / xml / svg）：整段吃掉再内部上色 ── */
    if (sp.markup && c === "<") {
      const e = fvTagEnd(s, i);
      if (e > i) {
        flush();
        out += fvHighlightTag(s.slice(i, e));
        i = e;
        continue;
      }
    }
    if (sp.entity && c === "&") {
      const m = /^&[#A-Za-z0-9]{1,8};/.exec(s.slice(i, Math.min(n, i + 12)));
      if (m) {
        add("num", m[0]);
        i += m[0].length;
        continue;
      }
    }

    /* ── 前缀型 token：ini [section] / css @media / py @decorator / sh $VAR ── */
    if (sp.section && c === "[" && fvAtLineHead(s, i)) {
      const m = /^\[[^\]\n]*\]/.exec(s.slice(i));
      if (m) {
        add("kw", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (c === "@") {
      if (sp.at) {
        const m = /^@[\w-]+/.exec(s.slice(i));
        if (m) {
          add(sp.at.has(m[0].slice(1).toLowerCase()) ? "kw" : "con", m[0]);
          i += m[0].length;
          continue;
        }
      }
      if (sp.decorator) {
        const m = /^@[\w.]+/.exec(s.slice(i));
        if (m) {
          add("fn", m[0]);
          i += m[0].length;
          continue;
        }
      }
    }
    if (sp.dollar && c === "$") {
      const m = /^\$\{?[\w#?*@/-]+\}?/.exec(s.slice(i));
      if (m) {
        add("prop", m[0]);
        i += m[0].length;
        continue;
      }
    }

    /* ── CSS 色值（#rgb / #rrggbbaa）：只在开了 hashNum 的语言里认，别把 markdown 标题吃成数字 ── */
    if (sp.hashNum && c === "#") {
      const m = /^#[0-9a-fA-F]{3,8}/.exec(s.slice(i, Math.min(n, i + 10)));
      if (m) {
        add("num", m[0]);
        i += m[0].length;
        continue;
      }
    }

    /* ── 数字（含 0x / 0b、下划线分隔、CSS 单位、版本号尾巴）── */
    if (sp.num && /[0-9]/.test(c)) {
      const m = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z%]{0,3}/.exec(s.slice(i));
      if (m) {
        add("num", m[0]);
        i += m[0].length;
        continue;
      }
    }

    /* ── 单词：字面量 / 关键字 / 函数调用名 / 键名，认不出来不着色 ── */
    if (FV_WORD_START.test(c) || (sp.dashWord && c === "-" && FV_WORD_START.test(s[i + 1] || ""))) {
      let j = s[i] === "@" ? i + 1 : i;
      if (sp.dashWord && s[j] === "-") j++;
      while (j < n) {
        const ch = s[j];
        if (FV_WORD_CHAR.test(ch)) {
          j++;
          continue;
        }
        /* 点号只有在两侧都是词字符时才算进名字（spring.datasource / foo.bar），
         * 否则 "http://" 里的点会把协议名吸进去 */
        if (ch === "." && j + 1 < n && FV_WORD_CHAR.test(s[j + 1]) && j > (s[i] === "@" ? i + 1 : i)) {
          j++;
          continue;
        }
        if (sp.dashWord && ch === "-" && j + 1 < n && FV_WORD_CHAR.test(s[j + 1])) {
          j++;
          continue;
        }
        break;
      }
      const word = s.slice(i, j);
      const after = s.slice(j, Math.min(n, j + 8));
      const lower = word.toLowerCase();
      let cls = "";
      if (sp.lit && (sp.lit.has(word) || sp.lit.has(lower))) cls = "bool";
      else if (sp.kw && (sp.kw.has(word) || (sp.ci && sp.kw.has(lower)))) cls = "kw";
      else if (sp.fnParen && /^[ \t]*\(/.test(after)) cls = "fn";
      else if (sp.keyColon && /^[ \t]*:(?![:=\\/])/.test(after)) cls = "prop";
      else if (sp.keyEq && /^[ \t]*=(?!=)/.test(after)) cls = "prop";
      add(cls, word);
      i = j;
      continue;
    }

    /* ── yaml 列表符（行首或空白后的 "-"）── */
    if (sp.dashPunc && c === "-" && (i === 0 || /[ \t\n]/.test(s[i - 1]))) {
      add("punc", "-");
      i++;
      continue;
    }

    add("punc", c);
    i++;
  }
  flush();
  return out;
}

/* diff / patch 按行分级：文件头 +++ --- 、段 @@ 、新增行、删除行。 */
function fvHighlightDiff(src) {
  const lines = String(src == null ? "" : src).split("\n");
  let out = "";
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    let cls = "";
    if (/^(\+\+\+|---)\s/.test(line)) cls = "kw";
    else if (/^@@/.test(line)) cls = "con";
    else if (/^diff |^index |^(new|old) file /m.test(line)) cls = "prop";
    else if (/^\+/.test(line)) cls = "str";
    else if (/^-/.test(line)) cls = "num";
    out += cls ? '<span class="jsl-' + cls + '">' + fvEsc(line) + "</span>" : fvEsc(line);
    if (k < lines.length - 1) out += "\n";
  }
  return out;
}

/* Markdown 源码着色：整行的结构件（标题 / 引用 / 列表 / 围栏 / 表格 / 缩进码）先定性，
 * 普通段落再处理行内 `code`、**粗体**、[链接](地址)。渲染效果另有 renderMarkdown，这里只管源码读得顺。 */
function fvHighlightMd(src) {
  const lines = String(src == null ? "" : src).split("\n");
  let out = "";
  let fence = "";
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const t = line.replace(/^[ \t]+/, "");
    let html;
    if (fence) {
      if (t.startsWith(fence) && t.replace(/[`~]/g, "").trim() === "") {
        html = '<span class="jsl-punc">' + fvEsc(line) + "</span>";
        fence = "";
      } else html = '<span class="jsl-com">' + fvEsc(line) + "</span>";
    } else if (/^(`{3,}|~{3,})/.test(t)) {
      fence = /^(`{3,}|~{3,})/.exec(t)[1];
      html = '<span class="jsl-punc">' + fvEsc(line) + "</span>";
    } else if (/^#{1,6}[ \t]/.test(t)) html = '<span class="jsl-kw">' + fvEsc(line) + "</span>";
    else if (/^>/.test(t)) html = '<span class="jsl-com">' + fvEsc(line) + "</span>";
    else if (/^\|/.test(t)) {
      html = line
        .split("|")
        .map((seg, idx) => (idx ? '<span class="jsl-punc">|</span>' : "") + fvHighlightMdInline(seg))
        .join("");
    } else if (/^(\s*)([-*+]|[0-9]+[.)])(\s+)(.*)$/.test(line)) {
      const m = /^(\s*)([-*+]|[0-9]+[.)])(\s+)(.*)$/.exec(line);
      html =
        fvEsc(m[1]) +
        '<span class="jsl-punc">' + fvEsc(m[2]) + "</span>" +
        fvEsc(m[3]) +
        fvHighlightMdInline(m[4]);
    } else if (/^[ \t]{4,}\S/.test(line)) html = '<span class="jsl-com">' + fvEsc(line) + "</span>";
    else if (/^\s*([-*_])[ \t]*(\1[ \t]*){2,}$/.test(line)) html = '<span class="jsl-punc">' + fvEsc(line) + "</span>";
    else html = fvHighlightMdInline(line);
    out += html;
    if (k < lines.length - 1) out += "\n";
  }
  return out;
}

/* 行内：先把整行转义成纯文本，再只在「闭合的成对片段」外包 span ——
 * 传进来的 text 已经是转义后的正文，包进去的 class 只会多不会少。 */
function fvHighlightMdInline(rawLine) {
  const text = fvEsc(rawLine);
  if (!text) return text;
  return (
    text
      /* 图片 ![alt](url) 与链接 [text](url) */
      .replace(/(!?\[[^\]\n]*\])(\([^)\s]+\))/g, '<span class="jsl-prop">$1</span><span class="jsl-str">$2</span>')
      /* 行内码与粗体：成对才认，不闭合的原样留着 */
      .replace(/(`[^`\n]+`)/g, '<span class="jsl-str">$1</span>')
      .replace(/(\*\*[^*\n]+\*\*|__[^_\n]+__)/g, '<span class="jsl-kw">$1</span>')
      .replace(/(^|[^*\w])(\*[^*\n]+\*|_[^_\n]+_)(?![*\w])/g, '$1<span class="jsl-con">$2</span>')
  );
}

/* 入口：代码 + 语言 id → 高亮 HTML。
 * js / ts / json 优先交给 app-codeedit.js 的词法（与函数节点编辑器完全同源），
 * yaml 优先交给 app.js 的 YAML 编辑器口径；两者拿不到时退回本文件的通用词法，
 * 未知语言与纯文本（txt / log / csv）只剩转义后的正文。 */
function fileviewHighlight(code, lang) {
  const s = String(code == null ? "" : code);
  if (!s) return "";
  const l = String(lang || "").toLowerCase();
  if ((l === "js" || l === "ts" || l === "tsx" || l === "json") && typeof jsHighlightHtml === "function") {
    return jsHighlightHtml(s);
  }
  if (l === "yaml" && typeof highlightYamlLine === "function") {
    return s.split("\n").map((line) => highlightYamlLine(line)).join("\n");
  }
  if (l === "md") return fvHighlightMd(s);
  if (l === "diff") return fvHighlightDiff(s);
  const spec = FV_SPECS[l];
  if (spec && (spec.line || spec.block || spec.str || spec.triple || spec.markup || spec.kw || spec.num)) {
    return fvHighlightGeneric(s, spec);
  }
  return fvEsc(s);
}

/* ============================================================
 * 二、右侧可关闭的文件查看面板（openFilePeek / closeFilePeek）
 * ------------------------------------------------------------
 * 只有用户点了会话工具条上的文件名才会出现；默认只读，「编辑」是文本文件里的显式动作：
 *   · 贴在窗口右侧的浮层（position: fixed，顶栏之下、状态栏之上，上下边界由
 *     filePeekSyncBounds() 现量 .topbar / .statusbar，不写死像素）；
 *   · 左边缘拖拽改宽，宽度与「折行」偏好按 review 面板那份惯例存 localStorage
 *     （键 filePeekSize）；
 *   · persistent：关闭只走显式路径（头部 ✕ / Esc）。AGENTS.md「协作约定」明令
 *     浮层不得挂「点外部 / 点蒙层即关」，所以这里既没有蒙层也没有 outside 监听
 *     ——面板不挡画布，用户可以一边看文件一边让会话继续跑；
 *   · 只此一个实例：切换文件走头部下方那条「最近文件」横条，不叠第二块面板。
 *
 * 三种视图按目标选：目录 → fileListDir 条目列表（点条目再开文件）；
 * 图片扩展名 → 内嵌 <img> 预览；其余 → 行号槽 + fileviewHighlight 高亮层；
 * 文本文件点「编辑」→ 换成编辑器视图（行号槽 + 高亮镜像层 + 透明输入框，见 renderFilePeekEditor）。
 *
 * 体积闸：fileReadText 是一次读整个文件（主进程没有分段读的口子），所以先用
 * fileStat 卡一道——超过 HARD 干脆不读（不把主进程按在一部大文件上），超过 SOFT
 * 读了也只显示前一段，超过 FLAT 关掉语法着色只出纯文本；三种情况都会在面板里
 * 显式说明，不假装文件只有这么多内容。被 SOFT 截过一截的文件不许进编辑态：
 * 那份正文不是全文，保存回去等于把后面整段抹掉。
 * ============================================================ */

const FV_PEEK_KEY = "filePeekSize";
const FV_PEEK_SOFT_BYTES = 1024 * 1024; /* 只显示前 1 MB */
const FV_PEEK_HARD_BYTES = 8 * 1024 * 1024; /* 超过 8 MB 不读 */
const FV_PEEK_FLAT_BYTES = 256 * 1024; /* 超过 256 KB 不着色 */
const FV_PEEK_MAX_LINES = 20000; /* 行号槽与高亮层的行数上限 */
const FV_PEEK_DIR_CAP = 600; /* 目录列表最多渲染多少条 */
const FV_PEEK_RECENT_MAX = 12; /* 最近文件横条最多记多少个 */
const FV_PEEK_EDIT_COALESCE_MS = 350; /* 连打合并：这段时间内的连续输入并成一次撤销 */
const FV_PEEK_UNDO_MAX = 200; /* 撤销栈上限（再多也没人真去点两百次） */

/* 面板运行态（模块级单例；DOM 节点不进这里，用时现查） */
const FV_PEEK = {
  path: "",
  mode: "read", /* read | write | dir（来自工具条徽标，只影响配色与文案） */
  line: 0, /* read 的 offset：打开后滚到这一行并整行标记 */
  count: 0, /* read 的 limit：只用于说明「这次请求读了多少行」 */
  lang: "",
  raw: "",
  size: 0,
  totalLines: 0,
  note: "",
  view: "", /* 当前这一屏是什么：code | md | dir | img | empty（决定哪几个按钮可用） */
  wrap: false,
  dims: "", /* 图片像素尺寸（只进头部那行小字，不占提示条） */
  mdSrc: false, /* md 等可渲染文件默认直接渲染（renderMarkdown），点「源码」才看原文 */
  req: 0, /* 递增请求号：慢请求回来时若已切走文件就丢弃 */
  open: false,
  dirList: null,
  dirFilter: "",
  recent: [],
  /* ── 编辑态（只有用户点了「编辑」才进；不进编辑态时这些字段全是空/关）──
   * 正文本身不进这里之外的地方：raw = 磁盘上那一份（保存后被换成新的），
   * editText = 编辑框里那一份，dirty = 两者不一样（有未保存改动）。 */
  editable: false, /* 这个文件能不能进编辑态（文本 · 没被截断 · 不是二进制 / 图片 / 目录） */
  editing: false, /* 是否正在编辑 */
  dirty: false, /* 改了还没保存 */
  editText: "",
  editBase: "", /* 上一次落进撤销栈的文本（连打合并的基准） */
  undo: [], /* 撤销栈（旧 → 新） */
  redo: [], /* 重做栈 */
  editTimer: 0, /* 连打合并计时器 */
  paintTimer: 0, /* 高亮重画节流计时器（每敲一个字都重扫全文太亏） */
  mtime: 0, /* 打开时的磁盘 mtime：保存前比一眼，别人改过就先问一句 */
};

/* ── 小工具 ── */

function fvFmtBytes(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 0) return "";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/* 目录条目拼接（fileListDir 的 rel 用 "/"，本地目录可能两种斜杠都有 → 统一交给归一） */
function fvPeekJoin(base, rel) {
  const b = String(base == null ? "" : base).replace(/[\\/]+$/, "");
  const r = String(rel == null ? "" : rel).replace(/^[\\/]+/, "");
  return fvNormalizePath(b ? b + "/" + r : r);
}

function fvPeekImgUrl(p, bust) {
  if (typeof fileUrlWithBust === "function") return fileUrlWithBust(p, bust);
  if (window.api && window.api.toFileUrl) {
    try {
      return window.api.toFileUrl(p);
    } catch (_) {}
  }
  return "";
}

function fvPeekCopy(txt) {
  const t = String(txt == null ? "" : txt);
  if (typeof dshClipboardWrite === "function") return dshClipboardWrite(t);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return Promise.resolve(navigator.clipboard.writeText(t));
  }
  if (window.api && window.api.clipboardWriteText) {
    return Promise.resolve(window.api.clipboardWriteText(t));
  }
  return Promise.reject(new Error("no clipboard"));
}

/* 面板当前是否开着（供工具条徽标画「已在看这个文件」的状态） */
function filePeekIsOpen() {
  return !!FV_PEEK.open;
}
function filePeekCurrentPath() {
  return FV_PEEK.path;
}

/* ── 宿主 DOM（懒建）── */

function ensureFilePeek() {
  let host = document.getElementById("filePeek");
  if (host) return host;
  host = document.createElement("div");
  host.id = "filePeek";
  host.className = "fp-host";
  host.innerHTML =
    '<div class="fp-box" id="fpBox" tabindex="-1" role="complementary" aria-label="' +
    I18n.t("文件查看") +
    '">' +
    '<div class="fp-resize" id="fpResize" title="' +
    I18n.t("拖拽左边缘调整宽度") +
    '"></div>' +
    '<div class="fp-head">' +
    '<span class="fp-mode" id="fpMode"></span>' +
    '<b class="fp-name" id="fpName"></b>' +
    '<span class="fp-meta" id="fpMeta"></span>' +
    '<div class="fp-acts">' +
    '<button type="button" class="fp-btn fp-btn-txt" id="fpWrapBtn"></button>' +
    '<button type="button" class="fp-btn fp-btn-txt" id="fpMdBtn" hidden></button>' +
    '<button type="button" class="fp-btn" id="fpUndoBtn" title="' +
    I18n.t("撤销") +
    ' (Ctrl+Z)" hidden>↶</button>' +
    '<button type="button" class="fp-btn" id="fpRedoBtn" title="' +
    I18n.t("重做") +
    ' (Ctrl+Y)" hidden>↷</button>' +
    '<button type="button" class="fp-btn fp-btn-txt" id="fpSaveBtn" hidden></button>' +
    '<button type="button" class="fp-btn fp-btn-txt" id="fpEditBtn" hidden></button>' +
    '<button type="button" class="fp-btn" id="fpCopyBtn" title="' +
    I18n.t("复制内容") +
    '">⧉</button>' +
    '<button type="button" class="fp-btn" id="fpCopyPathBtn" title="' +
    I18n.t("复制路径") +
    '">🔗</button>' +
    '<button type="button" class="fp-btn" id="fpRevealBtn" title="' +
    I18n.t("在资源管理器中显示") +
    '">📂</button>' +
    '<button type="button" class="fp-btn" id="fpReloadBtn" title="' +
    I18n.t("重新加载") +
    '">↻</button>' +
    '<button type="button" class="fp-btn fp-close" id="fpCloseBtn" title="' +
    I18n.t("关闭") +
    '">✕</button>' +
    "</div></div>" +
    '<div class="fp-path" id="fpPath"></div>' +
    '<div class="fp-recent" id="fpRecent" hidden></div>' +
    '<div class="fp-note" id="fpNote" hidden></div>' +
    '<div class="fp-scroll" id="fpScroll"></div>' +
    "</div>";
  document.body.appendChild(host);

  const box = host.querySelector("#fpBox");

  /* 显式关闭：头部 ✕ / Esc（Esc 只在焦点落在面板里时抢得到，不干扰画布） */
  host.querySelector("#fpCloseBtn").onclick = () => closeFilePeek();
  host.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeFilePeek();
    }
  });

  /* 宽度 / 折行偏好：与 review 面板同一套 localStorage 惯例 */
  try {
    const j = JSON.parse(localStorage.getItem(FV_PEEK_KEY) || "null");
    if (j && Number(j.w) > 0) FV_PEEK.w = Number(j.w);
    if (j && typeof j.wrap === "boolean") FV_PEEK.wrap = j.wrap;
  } catch (_) {}
  const savePrefs = () => {
    try {
      localStorage.setItem(
        FV_PEEK_KEY,
        JSON.stringify({ w: FV_PEEK.w, wrap: FV_PEEK.wrap }),
      );
    } catch (_) {}
  };
  /* 左边缘拖拽：往左拖变宽（跟鼠标走），夹在 [360, 窗口宽-320] 之间 */
  host.querySelector("#fpResize").addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const sx = ev.clientX;
    const base = box.offsetWidth;
    const move = (e) => filePeekSetWidth(base + (sx - e.clientX), true);
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      savePrefs();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  filePeekSetWidth(FV_PEEK.w || 0, false);
  window.addEventListener("resize", () => {
    if (FV_PEEK.open) filePeekSyncBounds();
  });

  /* 折行：只对代码视图 / 编辑视图有意义（换行后行号已对不上，行号槽会跟着收起） */
  host.querySelector("#fpWrapBtn").onclick = () => {
    FV_PEEK.wrap = !FV_PEEK.wrap;
    savePrefs();
    if (FV_PEEK.view === "edit") {
      /* 编辑态不重画（重画会把光标弹到文首），只把折行落到那个 textarea 上 */
      filePeekApplyEditorWrap(host.querySelector(".fp-editor"));
      renderFilePeekHead();
      return;
    }
    if (FV_PEEK.view === "code") renderFilePeekBody();
    else renderFilePeekHead();
  };
  /* Markdown：源码 / 渲染 两看（渲染复用 app.js 的 renderMarkdown） */
  host.querySelector("#fpMdBtn").onclick = () => {
    FV_PEEK.mdSrc = !FV_PEEK.mdSrc;
    renderFilePeekBody();
  };
  /* 编辑：进 / 出编辑态；保存：落盘；撤销 / 重做：走本文件自己的栈 */
  host.querySelector("#fpEditBtn").onclick = () => filePeekEditToggle();
  host.querySelector("#fpSaveBtn").onclick = () => filePeekEditSave();
  host.querySelector("#fpUndoBtn").onclick = () => filePeekEditUndo();
  host.querySelector("#fpRedoBtn").onclick = () => filePeekEditRedo();
  host.querySelector("#fpCopyBtn").onclick = () => {
    const txt = filePeekCopyableText();
    if (!txt) {
      toast(I18n.t("没有可复制的内容"), "warn");
      return;
    }
    fvPeekCopy(txt).then(
      () => toast(I18n.t("已复制文件内容"), "ok"),
      () => toast(I18n.t("复制失败"), "err"),
    );
  };
  host.querySelector("#fpCopyPathBtn").onclick = () => {
    if (!FV_PEEK.path) return;
    fvPeekCopy(FV_PEEK.path).then(
      () => toast(I18n.t("已复制文件路径"), "ok"),
      () => toast(I18n.t("复制失败"), "err"),
    );
  };
  host.querySelector("#fpRevealBtn").onclick = () => {
    if (!FV_PEEK.path) return;
    if (window.api && window.api.shellShowItem) {
      Promise.resolve(window.api.shellShowItem(FV_PEEK.path)).catch(() => {});
    }
  };
  host.querySelector("#fpReloadBtn").onclick = () => {
    /* 重读会把正文换成磁盘上那一份：有未保存改动就先问一句 */
    if (filePeekDirty()) {
      filePeekDiscardConfirm(I18n.t("有未保存的修改，重新加载会丢弃这些改动。")).then((ok) => {
        if (ok) loadFilePeek();
      });
      return;
    }
    loadFilePeek();
  };
  return host;
}

function filePeekSetWidth(w, remember) {
  const host = document.getElementById("filePeek");
  const vw = window.innerWidth || 1200;
  const minW = 360;
  const maxW = Math.max(minW, vw - 320);
  let nw = Number(w) || 0;
  if (!nw) nw = Math.round(Math.min(760, Math.max(420, vw * 0.42)));
  nw = Math.max(minW, Math.min(nw, maxW));
  FV_PEEK.w = nw;
  if (host) host.style.width = nw + "px";
  if (remember) {
    try {
      localStorage.setItem(
        FV_PEEK_KEY,
        JSON.stringify({ w: nw, wrap: FV_PEEK.wrap }),
      );
    } catch (_) {}
  }
}

/* 上下边界跟着顶栏 / 状态栏的实际高度走（顶栏可能换行成多排，不能写死） */
function filePeekSyncBounds() {
  const host = document.getElementById("filePeek");
  if (!host) return;
  const tb = document.querySelector(".topbar");
  const sb = document.querySelector(".statusbar");
  let top = 52;
  let bottom = 26;
  try {
    if (tb) top = Math.round(tb.getBoundingClientRect().height) + 8;
    if (sb) bottom = Math.round(sb.getBoundingClientRect().height) + 8;
  } catch (_) {}
  host.style.top = top + "px";
  host.style.bottom = bottom + "px";
}

/* ── 打开 / 关闭 ── */

/* openFilePeek(path, { mode, line, count, base })
 * path 可以是工具参数里的原样路径（相对路径按 base = 该会话生效工作区补全）。
 * 返回 false = 没能打开（路径定位不到），调用方自己决定要不要提示。 */
function openFilePeek(path, opts) {
  const o = opts || {};
  const rawPath = String(path == null ? "" : path).trim();
  if (!rawPath) return false;
  let abs = resolveToolPath(rawPath, o.base || "");
  if (!fileviewPathIsOpenable(abs) && typeof resolveOpenableFilePath === "function") {
    try {
      abs = resolveOpenableFilePath(abs) || abs;
    } catch (_) {}
  }
  if (!fileviewPathIsOpenable(abs)) {
    toast(I18n.t("无法定位该文件的完整路径，只给你看文件名"), "warn");
    return false;
  }
  /* 换文件而当前那份还没保存：先问一句，确认放弃后再真开（返回 true = 请求已受理，
     调用方别把它当成打不开再补一条提示）。 */
  if (filePeekDirty() && FV_PEEK.path && FV_PEEK.path !== abs) {
    const keepPath = String(path == null ? "" : path);
    const keepOpts = o;
    filePeekDiscardConfirm(I18n.t("有未保存的修改，换文件会丢弃这些改动。")).then((ok) => {
      if (ok) openFilePeek(keepPath, keepOpts);
    });
    return true;
  }
  const host = ensureFilePeek();
  FV_PEEK.path = abs;
  FV_PEEK.mode = o.mode === "write" || o.mode === "dir" ? o.mode : "read";
  /* 同一个徽标再点一次也可能指向别的行（read 的 offset 变了），所以每次都按最新
     line/count 重来一遍，并重新读文件 —— Agent 很可能在这期间改过它。 */
  FV_PEEK.line = Number(o.line) || 0;
  FV_PEEK.count = Number(o.count) || 0;
  FV_PEEK.mdSrc = false; /* 每次打开都回到「渲染」默认，与面板初始态一致 */
  FV_PEEK.dirFilter = "";
  FV_PEEK.dirList = null;
  host.classList.add("on");
  FV_PEEK.open = true;
  filePeekSetWidth(FV_PEEK.w || 0, false);
  filePeekSyncBounds();
  filePeekRemember(abs, FV_PEEK.mode);
  renderFilePeekHead();
  loadFilePeek();
  try {
    host.querySelector("#fpBox").focus({ preventScroll: true });
  } catch (_) {}
  return true;
}

function closeFilePeek() {
  const host = document.getElementById("filePeek");
  if (!host) return;
  /* 有未保存改动就先把「放弃改动」问清楚，再真的收起 */
  if (filePeekDirty()) {
    filePeekDiscardConfirm(I18n.t("有未保存的修改，关闭面板会丢弃这些改动。")).then((ok) => {
      if (ok) closeFilePeekNow();
    });
    return;
  }
  closeFilePeekNow();
}

/* 真的收起（关闭前那一道确认在 closeFilePeek 里，这里只管切状态） */
function closeFilePeekNow() {
  const host = document.getElementById("filePeek");
  if (!host) return;
  host.classList.remove("on");
  FV_PEEK.open = false;
}

/* 再点同一个徽标 = 收起（面板唯一的「开关式」关闭路径，不靠点外部） */
function toggleFilePeek(path, opts) {
  const o = opts || {};
  const abs = resolveToolPath(String(path || "").trim(), o.base || "");
  if (filePeekIsOpen() && abs && filePeekCurrentPath() === abs) {
    closeFilePeek();
    return false;
  }
  return openFilePeek(path, o);
}

function filePeekRemember(abs, mode) {
  const name = fileviewBaseName(abs) || abs;
  const list = FV_PEEK.recent.filter((r) => r.path !== abs);
  list.unshift({ path: abs, name: name, mode: mode || "read" });
  if (list.length > FV_PEEK_RECENT_MAX) list.length = FV_PEEK_RECENT_MAX;
  FV_PEEK.recent = list;
  renderFilePeekRecent();
}

/* ── 头部 ── */

const FV_MODE_LABEL = {
  read: "读",
  write: "改",
  dir: "目录",
};

function renderFilePeekHead() {
  const host = document.getElementById("filePeek");
  if (!host) return;
  const abs = FV_PEEK.path;
  const name = fileviewBaseName(abs) || abs;
  const modeEl = host.querySelector("#fpMode");
  modeEl.textContent = I18n.t(FV_MODE_LABEL[FV_PEEK.mode] || FV_MODE_LABEL.read);
  modeEl.className = "fp-mode m-" + (FV_PEEK.mode || "read");
  const nameEl = host.querySelector("#fpName");
  nameEl.textContent = name;
  nameEl.title = abs;
  const pathEl = host.querySelector("#fpPath");
  pathEl.textContent = abs;
  pathEl.title = abs;
  host.querySelector("#fpWrapBtn").textContent = I18n.t(FV_PEEK.wrap ? "不换行" : "折行");
  host.querySelector("#fpWrapBtn").classList.toggle("on", !!FV_PEEK.wrap);
  /* 折行在代码视图与编辑视图里都有意义：目录 / 图片 / 空态就别摆一个按了没反应的按钮 */
  host.querySelector("#fpWrapBtn").hidden =
    FV_PEEK.view !== "code" && FV_PEEK.view !== "edit";
  const mdBtn = host.querySelector("#fpMdBtn");
  const isMd = FV_PEEK.lang === "md" && !!FV_PEEK.raw;
  mdBtn.hidden = !isMd || !!FV_PEEK.editing;
  if (isMd) mdBtn.textContent = I18n.t(FV_PEEK.mdSrc ? "渲染" : "源码");
  mdBtn.classList.toggle("on", !FV_PEEK.mdSrc);
  /* 编辑一组的可见性：能编辑的文本文件给「编辑」；在编辑里换成「取消 / 保存 / 撤销 / 重做」 */
  const editBtn = host.querySelector("#fpEditBtn");
  const canEdit =
    !!FV_PEEK.editable && (FV_PEEK.view === "code" || FV_PEEK.view === "md" || FV_PEEK.view === "edit");
  editBtn.hidden = !canEdit && !FV_PEEK.editing;
  const saveBtn = host.querySelector("#fpSaveBtn");
  saveBtn.hidden = !FV_PEEK.editing;
  saveBtn.textContent = I18n.t("保存");
  host.querySelector("#fpUndoBtn").hidden = !FV_PEEK.editing;
  host.querySelector("#fpRedoBtn").hidden = !FV_PEEK.editing;
  renderFilePeekMeta();
  filePeekEditSync();
}

/* 头部那一行小字：体积 · 行数 · 语言（· 目录条目数） · 本次读的行区间 */
function renderFilePeekMeta() {
  const host = document.getElementById("filePeek");
  if (!host) return;
  const bits = [];
  if (FV_PEEK.mode === "dir" && FV_PEEK.dirList) {
    bits.push(FV_PEEK.dirList.length + " " + I18n.t("个条目"));
  } else {
    if (FV_PEEK.size > 0) bits.push(fvFmtBytes(FV_PEEK.size));
    if (FV_PEEK.dims) bits.push(FV_PEEK.dims);
    if (FV_PEEK.totalLines) bits.push(FV_PEEK.totalLines + " " + I18n.t("行"));
    if (FV_PEEK.lang) bits.push(FV_PEEK.lang);
  }
  if (FV_PEEK.line) bits.push("L" + FV_PEEK.line + (FV_PEEK.count ? "×" + FV_PEEK.count : ""));
  const el = host.querySelector("#fpMeta");
  el.textContent = bits.join(" · ");
  el.title = el.textContent;
}

/* note = 本次读取本身要说的事（不存在 / 太大 / 二进制），extra = 这一屏渲染追加的说；
   两者分开存，避免「切一下折行就把同一句提示重复拼一遍」。 */
function renderFilePeekNote(extra) {
  const host = document.getElementById("filePeek");
  if (!host) return;
  const el = host.querySelector("#fpNote");
  const txt = [FV_PEEK.note, extra].filter(Boolean).join("；");
  el.textContent = txt;
  el.hidden = !txt;
}

function renderFilePeekRecent() {
  const host = document.getElementById("filePeek");
  if (!host) return;
  const strip = host.querySelector("#fpRecent");
  strip.innerHTML = "";
  if (FV_PEEK.recent.length < 2) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  const lab = document.createElement("span");
  lab.className = "fp-recent-lab";
  lab.textContent = I18n.t("最近");
  strip.appendChild(lab);
  for (const r of FV_PEEK.recent) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fp-rchip m-" + (r.mode || "read") + (r.path === FV_PEEK.path ? " cur" : "");
    b.textContent = r.name;
    b.title = r.path;
    b.onclick = () => openFilePeek(r.path, { mode: r.mode });
    strip.appendChild(b);
  }
}

function filePeekCopyableText() {
  if (FV_PEEK.raw) return FV_PEEK.raw;
  if (FV_PEEK.dirList && FV_PEEK.dirList.length) {
    return FV_PEEK.dirList.map((e) => fvPeekJoin(FV_PEEK.path, e.rel)).join("\n");
  }
  return "";
}

/* ============================================================
 * 二之一、编辑态：进 / 出 · 撤销重做 · 保存
 * ------------------------------------------------------------
 * 为什么编辑要用户显式点一下、而不是打开就能改：这个面板本来只是「看」，同一份文件
 * 很可能正被会话里的 Agent 改着，手滑敲一个字符就多一份脏改动。所以：
 *   · 只有文本文件（读到了正文、没被体积闸截断、不是二进制 / 图片 / 目录）才有「编辑」；
 *   · 保存是唯一写盘的口子，而且写之前比一眼 mtime —— 别覆盖别人的改动；
 *   · 未保存的改动在换文件 / 重读 / 收起面板前一律先确认，绝不默默丢字；
 *   · 撤销栈是本文件自己的一叠快照（textarea 原生栈拦不住、也没法拿来当按钮用）。
 * ============================================================ */

/* 有没有「改了还没保存」的东西 —— 三个退出路径都要先问它一句 */
function filePeekDirty() {
  return !!(FV_PEEK.editing && FV_PEEK.dirty);
}

/* 未保存改动确认：返回 Promise<bool>，true = 可以继续（改动已丢弃，或本来就不脏）。
   走应用内 confirmDialog（AGENTS.md：带输入的浮层一律 persistent，不做点外部即关）；
   拿不到它（切片跑测试等）时按「不继续」处理 —— 宁可不动，也不悄悄丢用户的字。 */
function filePeekDiscardConfirm(msg) {
  if (!filePeekDirty()) return Promise.resolve(true);
  const ask =
    typeof confirmDialog === "function"
      ? confirmDialog(msg, {
          title: I18n.t("未保存的修改"),
          okText: I18n.t("放弃改动"),
          cancelText: I18n.t("取消"),
          danger: true,
        })
      : Promise.resolve(false);
  return Promise.resolve(ask).then((ok) => {
    if (ok) filePeekEditReset();
    return !!ok;
  });
}

/* 清掉编辑态（不动视图、不动正文）：换文件 / 丢掉改动 / 收起面板时用 */
function filePeekEditReset() {
  for (const k of ["editTimer", "paintTimer"]) {
    if (!FV_PEEK[k]) continue;
    try {
      clearTimeout(FV_PEEK[k]);
    } catch (_) {}
    FV_PEEK[k] = 0;
  }
  FV_PEEK.editing = false;
  FV_PEEK.dirty = false;
  FV_PEEK.editText = "";
  FV_PEEK.editBase = "";
  FV_PEEK.undo = [];
  FV_PEEK.redo = [];
}

function filePeekEditToggle() {
  if (FV_PEEK.editing) {
    filePeekEditCancel();
    return;
  }
  filePeekEditEnter();
}

function filePeekEditEnter() {
  if (!FV_PEEK.editable || !FV_PEEK.path) return false;
  if (!FV_PEEK.raw) return false; /* 空文件 / 二进制 / 读不到：没有可编辑的正文 */
  FV_PEEK.editing = true;
  FV_PEEK.dirty = false;
  FV_PEEK.editText = String(FV_PEEK.raw || "");
  FV_PEEK.editBase = FV_PEEK.editText;
  FV_PEEK.undo = [];
  FV_PEEK.redo = [];
  renderFilePeekBody();
  return true;
}

/* 头部「取消」：改过就确认一句，确认后才退回只读（md 回渲染视图，与打开时一致） */
function filePeekEditCancel() {
  if (!FV_PEEK.editing) return;
  if (!filePeekDirty()) {
    filePeekEditExit();
    return;
  }
  filePeekDiscardConfirm(I18n.t("有未保存的修改，退出编辑会丢弃这些改动。")).then((ok) => {
    if (ok) filePeekEditExit();
  });
}

function filePeekEditExit() {
  const wasMd = FV_PEEK.lang === "md";
  filePeekEditReset();
  if (wasMd) FV_PEEK.mdSrc = false;
  renderFilePeekBody();
}

/* 连打合并：把这一段连续输入并成一次撤销（每敲一个字都进栈的话，撤销要点上百次）。
   输入停下 FV_PEEK_EDIT_COALESCE_MS 后落一次栈；Ctrl+Z / 点按钮会先强制落栈。 */
function filePeekEditPush() {
  FV_PEEK.dirty = FV_PEEK.editText !== String(FV_PEEK.raw || "");
  if (FV_PEEK.editTimer) return;
  FV_PEEK.editTimer = setTimeout(() => {
    FV_PEEK.editTimer = 0;
    filePeekEditFlush();
    filePeekEditSync();
  }, FV_PEEK_EDIT_COALESCE_MS);
}

/* 落一次栈；返回是否真的落下（editBase 与 editText 相同 = 这段没改动） */
function filePeekEditFlush() {
  if (FV_PEEK.editTimer) {
    try {
      clearTimeout(FV_PEEK.editTimer);
    } catch (_) {}
    FV_PEEK.editTimer = 0;
  }
  if (!FV_PEEK.editing) return false;
  if (FV_PEEK.editText === FV_PEEK.editBase) return false;
  FV_PEEK.undo.push(FV_PEEK.editBase);
  if (FV_PEEK.undo.length > FV_PEEK_UNDO_MAX) FV_PEEK.undo.shift();
  FV_PEEK.editBase = FV_PEEK.editText;
  FV_PEEK.redo = [];
  return true;
}

function filePeekEditUndo() {
  if (!FV_PEEK.editing) return false;
  filePeekEditFlush();
  if (!FV_PEEK.undo.length) {
    filePeekEditSync();
    return false;
  }
  FV_PEEK.redo.push(FV_PEEK.editText);
  const prev = FV_PEEK.undo.pop();
  FV_PEEK.editText = prev;
  FV_PEEK.editBase = prev;
  filePeekEditApply();
  return true;
}

function filePeekEditRedo() {
  if (!FV_PEEK.editing) return false;
  filePeekEditFlush();
  if (!FV_PEEK.redo.length) {
    filePeekEditSync();
    return false;
  }
  const next = FV_PEEK.redo.pop();
  FV_PEEK.undo.push(FV_PEEK.editText);
  FV_PEEK.editText = next;
  FV_PEEK.editBase = next;
  filePeekEditApply();
  return true;
}

/* 把状态里的正文写回那个 textarea（撤销 / 重做后调；光标摆到末尾），
   同时立刻重画底下那层高亮 —— 镜像层晚一步就跟不上刚换上的正文。 */
function filePeekEditApply() {
  const host = document.getElementById("filePeek");
  const ta = host ? host.querySelector(".fp-editor") : null;
  if (ta) {
    ta.value = FV_PEEK.editText;
    try {
      /* 点完按钮焦点落在按钮上，不还给编辑框的话接着敲键盘就全落空了 */
      ta.focus();
      ta.setSelectionRange(FV_PEEK.editText.length, FV_PEEK.editText.length);
    } catch (_) {}
  }
  filePeekEditPaintNow();
  filePeekEditSync();
}

/* 头部按钮的文字 / 可用态 + 未保存标记（每次输入、撤销重做、保存后都要走一遍） */
function filePeekEditSync() {
  const host = document.getElementById("filePeek");
  if (!host) return;
  FV_PEEK.dirty = !!FV_PEEK.editing && FV_PEEK.editText !== String(FV_PEEK.raw || "");
  host.classList.toggle("fp-dirty", !!FV_PEEK.dirty);
  const nameEl = host.querySelector("#fpName");
  if (nameEl) {
    const name = fileviewBaseName(FV_PEEK.path) || FV_PEEK.path;
    /* 未保存就在文件名后面挂一个点：不靠颜色单独表达状态 */
    nameEl.textContent = FV_PEEK.dirty ? name + " •" : name;
  }
  const undoBtn = host.querySelector("#fpUndoBtn");
  const redoBtn = host.querySelector("#fpRedoBtn");
  const saveBtn = host.querySelector("#fpSaveBtn");
  const editBtn = host.querySelector("#fpEditBtn");
  /* 撤销可点 = 栈里有东西，或还有「刚敲进去、等着合并落栈」的一段
     （只按栈判的话，刚敲完那 350ms 里按钮是灰的 —— 点了没反应比灰着更让人困惑） */
  const pending = FV_PEEK.editing && FV_PEEK.editText !== FV_PEEK.editBase;
  if (undoBtn) undoBtn.disabled = !FV_PEEK.undo.length && !pending;
  if (redoBtn) redoBtn.disabled = !FV_PEEK.redo.length;
  if (saveBtn) saveBtn.disabled = !FV_PEEK.dirty;
  if (editBtn) editBtn.textContent = I18n.t(FV_PEEK.editing ? "取消" : "编辑");
}

/* 折行落到整个编辑视图上（不重画 = 光标不会弹回文首）：
 *   · 输入框：wrap 属性 + .fp-edwrap（软折）；
 *   · 镜像层：跟着折（.fp-scroll.fp-wrap .fp-mirror）并让出常驻滚动条的宽度，不然两层换行点差一条滚动条；
 *   · 行号槽：由 CSS 收起（折行后一行代码占好几行，行号已经对不上）。 */
function filePeekApplyEditorWrap(ta) {
  const host = document.getElementById("filePeek");
  const scroller = host ? host.querySelector("#fpScroll") : null;
  if (scroller) scroller.classList.toggle("fp-wrap", !!FV_PEEK.wrap);
  if (!ta) return;
  ta.setAttribute("wrap", FV_PEEK.wrap ? "soft" : "off");
  ta.classList.toggle("fp-edwrap", !!FV_PEEK.wrap);
  filePeekEditSyncScroll();
}

function filePeekEditorKey(ev) {
  /* Esc 在编辑框里 = 退出编辑（不收起整个面板）：面板那条 Esc 收面板的路径留给
     焦点不在编辑框的时候，否则改到一半随手一按 Esc 就把面板关了。 */
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    filePeekEditCancel();
    return;
  }
  if (!ev.ctrlKey && !ev.metaKey) return;
  const k = String(ev.key || "").toLowerCase();
  if (k === "s") {
    ev.preventDefault();
    ev.stopPropagation();
    filePeekEditSave();
    return;
  }
  if (k === "z" && !ev.shiftKey) {
    ev.preventDefault();
    ev.stopPropagation();
    filePeekEditUndo();
    return;
  }
  if (k === "y" || (k === "z" && ev.shiftKey)) {
    ev.preventDefault();
    ev.stopPropagation();
    filePeekEditRedo();
  }
}

/* 保存：先比一眼 mtime（打开之后别人改过就先问一句），再写盘，成功才把基准换掉。
   撤销栈保留（保存后还能回退），mtime / 体积 / 行数重新对齐磁盘。 */
async function filePeekEditSave() {
  if (!FV_PEEK.editing) return false;
  const abs = FV_PEEK.path;
  const txt = String(FV_PEEK.editText == null ? "" : FV_PEEK.editText);
  const api = window.api || {};
  if (!api.fileWriteText) {
    FV_PEEK.note = I18n.t("当前环境写不了文件");
    renderFilePeekNote();
    return false;
  }
  try {
    if (api.fileStat) {
      const st = await api.fileStat(abs);
      const mt = st && st.ok ? Number(st.mtime) || 0 : 0;
      if (mt && FV_PEEK.mtime && mt !== FV_PEEK.mtime) {
        const go = await filePeekOverwriteConfirm();
        if (!go) return false;
      }
    }
    const r = await api.fileWriteText(abs, txt);
    if (r && r.ok === false) {
      FV_PEEK.note = I18n.t("保存失败：") + ((r && r.error) || "");
      renderFilePeekNote();
      return false;
    }
  } catch (e) {
    FV_PEEK.note = I18n.t("保存失败：") + String((e && e.message) || e);
    renderFilePeekNote();
    return false;
  }
  FV_PEEK.raw = txt;
  FV_PEEK.size = txt.length;
  FV_PEEK.totalLines = txt ? txt.split("\n").length : 0;
  FV_PEEK.editBase = txt;
  FV_PEEK.dirty = false;
  FV_PEEK.note = "";
  if (api.fileStat) {
    try {
      const st2 = await api.fileStat(abs);
      if (st2 && st2.ok) {
        FV_PEEK.mtime = Number(st2.mtime) || FV_PEEK.mtime;
        if (Number(st2.size) > 0) FV_PEEK.size = Number(st2.size);
      }
    } catch (_) {}
  }
  renderFilePeekHead();
  renderFilePeekNote();
  /* 焦点还给编辑框：接着改不用再点一下，Ctrl+S / Ctrl+Z 也留在编辑框这条路径上
     （不还给编辑框的话，它们会冒泡到画布那份全局快捷键去） */
  const host = document.getElementById("filePeek");
  const ed = host && host.querySelector ? host.querySelector(".fp-editor") : null;
  if (ed) {
    try {
      ed.focus();
    } catch (_) {}
  }
  toast(I18n.t("已保存"), "ok");
  return true;
}

/* 磁盘上的文件在打开后被动过：覆盖前问一句（默认不覆盖） */
function filePeekOverwriteConfirm() {
  if (typeof confirmDialog !== "function") return Promise.resolve(false);
  return Promise.resolve(
    confirmDialog(I18n.t("这个文件在打开后被别的程序改过，保存会覆盖对方的改动。"), {
      title: I18n.t("文件已被修改"),
      okText: I18n.t("仍然覆盖"),
      cancelText: I18n.t("取消"),
      danger: true,
    }),
  ).then((ok) => !!ok);
}

/* ── 读取与分发 ── */

async function loadFilePeek() {
  const host = ensureFilePeek();
  const abs = FV_PEEK.path;
  if (!abs) return;
  const req = ++FV_PEEK.req;
  /* 这一次是从磁盘重读：把编辑态整个作废（调用方在重读前已经过了「放弃改动」那道确认），
     免得正文换了新的、撤销栈里还是旧的那一份。 */
  filePeekEditReset();
  FV_PEEK.editable = false;
  FV_PEEK.mtime = 0;
  FV_PEEK.raw = "";
  FV_PEEK.note = "";
  FV_PEEK.dims = "";
  FV_PEEK.view = "";
  FV_PEEK.size = 0;
  FV_PEEK.totalLines = 0;
  FV_PEEK.dirList = null;
  FV_PEEK.lang = fileviewLangOf(abs);
  renderFilePeekHead();
  const scroller = host.querySelector("#fpScroll");
  scroller.className = "fp-scroll";
  scroller.innerHTML =
    '<div class="fp-loading">' + I18n.t("读取中…") + "</div>";
  const api = window.api || {};
  let isDir = false;
  if (api.fileIsDir) {
    try {
      isDir = !!(await api.fileIsDir(abs));
    } catch (_) {
      isDir = false;
    }
  }
  if (req !== FV_PEEK.req || FV_PEEK.path !== abs) return;
  if (isDir) {
    await loadFilePeekDir(abs, req);
    return;
  }
  if (api.fileStat) {
    try {
      const st = await api.fileStat(abs);
      if (st && st.ok) {
        FV_PEEK.size = Number(st.size) || 0;
        FV_PEEK.mtime = Number(st.mtime) || 0;
      }
    } catch (_) {}
  }
  if (req !== FV_PEEK.req || FV_PEEK.path !== abs) return;
  if (FV_PEEK.mode === "dir") FV_PEEK.mode = "read";
  if (fileviewIsImagePath(abs) && fileviewExtOf(abs) !== "svg") {
    /* svg 是文本，开发者更想看的是它的源码而不是画出来的样子（xml 高亮照样有） */
    if (api.assetMeta) {
      try {
        const m = await api.assetMeta(abs);
        if (m && m.ok) {
          FV_PEEK.size = Number(m.bytes) || FV_PEEK.size;
          if (m.width && m.height) FV_PEEK.dims = m.width + "×" + m.height;
        }
      } catch (_) {}
    }
    renderFilePeekHead();
    renderFilePeekImage();
    return;
  }
  if (FV_PEEK.size > FV_PEEK_HARD_BYTES) {
    FV_PEEK.note =
      I18n.t("文件过大（") + fvFmtBytes(FV_PEEK.size) + I18n.t("），预览上限 ") +
      fvFmtBytes(FV_PEEK_HARD_BYTES) + I18n.t("；请用「在资源管理器中显示」交给外部编辑器");
    renderFilePeekEmpty();
    return;
  }
  if (!api.fileReadText) {
    FV_PEEK.note = I18n.t("当前环境读不到文件");
    renderFilePeekEmpty();
    return;
  }
  let r = null;
  try {
    r = await api.fileReadText(abs);
  } catch (err) {
    r = null;
  }
  if (req !== FV_PEEK.req || FV_PEEK.path !== abs) return;
  if (!r || !r.exists) {
    FV_PEEK.note =
      FV_PEEK.mode === "write"
        ? I18n.t("这个文件现在还不存在（工具可能还没写完，或写的是别的路径）")
        : I18n.t("文件不存在或读不到（可能已被删除 / 改名）");
    renderFilePeekEmpty();
    return;
  }
  /* 一律归一成 \n：innerHTML 解析时浏览器会把 CRLF / 孤立的 CR 也当成换行，
     若不归一，JS 侧 split("\n") 数出来的行数会比真正渲染出来的行数少 —— 行号槽
     从第一个孤立 CR 起整体错位。复制时拿到的也是这一份归一文本。 */
  let txt = String(r.content == null ? "" : r.content).replace(/\r\n?/g, "\n");
  FV_PEEK.totalLines = txt ? txt.split("\n").length : 0;
  if (!txt) {
    FV_PEEK.note = I18n.t("文件是空的");
    renderFilePeekEmpty();
    return;
  }
  if (looksBinary(txt)) {
    FV_PEEK.note = I18n.t("这看起来是个二进制文件，没有做预览");
    renderFilePeekEmpty();
    return;
  }
  let cut = false; /* 被 1 MB 那道闸截过一截：这份正文不是全文，不许编辑（保存回去会抹掉后半截） */
  if (txt.length > FV_PEEK_SOFT_BYTES) {
    txt = txt.slice(0, FV_PEEK_SOFT_BYTES);
    cut = true;
    FV_PEEK.note =
      I18n.t("只显示前 ") + fvFmtBytes(FV_PEEK_SOFT_BYTES) + I18n.t("（共 ") +
      fvFmtBytes(FV_PEEK.size) + I18n.t("）");
  }
  FV_PEEK.raw = txt;
  FV_PEEK.editable = !cut;
  renderFilePeekBody();
}

function looksBinary(txt) {
  const head = txt.slice(0, 4096);
  let bad = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32) bad++;
  }
  return bad > 8;
}

async function loadFilePeekDir(abs, req) {
  const api = window.api || {};
  FV_PEEK.mode = "dir";
  let list = [];
  let err = "";
  if (api.fileListDir) {
    try {
      const lr = await api.fileListDir(abs);
      if (lr && lr.ok) list = lr.list || [];
      else err = (lr && lr.error) || "";
    } catch (e) {
      err = String((e && e.message) || e);
    }
  }
  if (req !== FV_PEEK.req || FV_PEEK.path !== abs) return;
  list = list.slice().sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
  FV_PEEK.dirList = list;
  FV_PEEK.totalLines = 0;
  FV_PEEK.note = err
    ? I18n.t("读目录失败：") + err
    : list.length
      ? ""
      : I18n.t("目录里没有文件（空目录，或只有被忽略的隐藏 / 重型目录）");
  renderFilePeekHead();
  renderFilePeekDir();
}

/* ── 视图：目录 / 图片 / 空 ── */

function renderFilePeekDir() {
  const host = document.getElementById("filePeek");
  FV_PEEK.view = "dir";
  const scroller = host.querySelector("#fpScroll");
  scroller.innerHTML = "";
  scroller.className = "fp-scroll fp-vdir";
  const wrap = document.createElement("div");
  wrap.className = "fp-dir";
  const list = FV_PEEK.dirList || [];
  const filt = document.createElement("input");
  filt.type = "text";
  filt.className = "fp-dir-filter";
  filt.placeholder = I18n.t("过滤条目…");
  filt.value = FV_PEEK.dirFilter || "";
  const rows = document.createElement("div");
  rows.className = "fp-dir-rows";
  const paint = () => {
    const q = String(filt.value || "").trim().toLowerCase();
    FV_PEEK.dirFilter = filt.value || "";
    rows.innerHTML = "";
    const hits = q
      ? list.filter((e) => String(e.rel).toLowerCase().indexOf(q) >= 0)
      : list;
    if (!hits.length) {
      const e2 = document.createElement("div");
      e2.className = "fp-dir-more";
      e2.textContent = I18n.t("没有匹配的条目");
      rows.appendChild(e2);
      return;
    }
    const shown = hits.slice(0, FV_PEEK_DIR_CAP);
    for (const e of shown) rows.appendChild(filePeekDirRow(e));
    if (hits.length > shown.length) {
      const more = document.createElement("div");
      more.className = "fp-dir-more";
      more.textContent =
        I18n.t("还有 ") + (hits.length - shown.length) + I18n.t(" 条没列出，继续输入可过滤");
      rows.appendChild(more);
    }
  };
  filt.oninput = paint;
  wrap.appendChild(filt);
  wrap.appendChild(rows);
  scroller.appendChild(wrap);
  paint();
  renderFilePeekHead();
  /* fileListDir 是「递归 + 只要文件」：跳过隐藏项与 node_modules / .git，也不单列子目录，
     不写这句用户会以为列到的就是全部。 */
  renderFilePeekNote(
    list.length
      ? I18n.t("递归列表：只列文件，已跳过隐藏项与 node_modules / .git")
      : "",
  );
}

function filePeekDirRow(e) {
  const abs = fvPeekJoin(FV_PEEK.path, e.rel);
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fp-dir-row";
  const nm = document.createElement("span");
  nm.className = "fp-dir-n";
  nm.textContent = fileviewBaseName(e.rel) || e.rel;
  const rl = document.createElement("span");
  rl.className = "fp-dir-rel";
  const cut = String(e.rel).lastIndexOf("/");
  rl.textContent = cut > 0 ? String(e.rel).slice(0, cut) : "";
  const sz = document.createElement("span");
  sz.className = "fp-dir-sz";
  sz.textContent = fvFmtBytes(e.size);
  b.appendChild(nm);
  b.appendChild(rl);
  b.appendChild(sz);
  b.title = abs;
  b.onclick = () => openFilePeek(abs, { mode: "read" });
  return b;
}

function renderFilePeekImage() {
  const host = document.getElementById("filePeek");
  FV_PEEK.view = "img";
  const scroller = host.querySelector("#fpScroll");
  scroller.innerHTML = "";
  scroller.className = "fp-scroll fp-vimg";
  const wrap = document.createElement("div");
  wrap.className = "fp-imgwrap";
  const img = document.createElement("img");
  img.className = "fp-img";
  img.alt = fileviewBaseName(FV_PEEK.path);
  img.src = fvPeekImgUrl(FV_PEEK.path, FV_PEEK.req);
  img.onerror = () => {
    FV_PEEK.note = I18n.t("图片显示不出来（格式不支持或文件读不到）");
    renderFilePeekNote();
  };
  wrap.appendChild(img);
  scroller.appendChild(wrap);
  renderFilePeekHead();
  renderFilePeekNote();
}

/* 空态（不存在 / 太大 / 二进制 / 空文件）：原因直接写进卡片，提示条不重复一遍 */
function renderFilePeekEmpty() {
  const host = document.getElementById("filePeek");
  FV_PEEK.view = "empty";
  const scroller = host.querySelector("#fpScroll");
  scroller.innerHTML = "";
  scroller.className = "fp-scroll";
  const box = document.createElement("div");
  box.className = "fp-blank";
  box.textContent = FV_PEEK.note || I18n.t("没有可预览的内容");
  scroller.appendChild(box);
  FV_PEEK.raw = "";
  const noteEl = host.querySelector("#fpNote");
  noteEl.textContent = "";
  noteEl.hidden = true;
  renderFilePeekHead();
  renderFilePeekRecent();
}

/* Markdown 渲染视图：套用现成的 .md-viewer-doc 版式（应用内阅读器同一套） */
function renderFilePeekMd() {
  const host = document.getElementById("filePeek");
  FV_PEEK.view = "md";
  const scroller = host.querySelector("#fpScroll");
  scroller.innerHTML = "";
  scroller.className = "fp-scroll fp-vmd";
  const doc = document.createElement("div");
  doc.className = "md-viewer-doc fp-md";
  let html = "";
  try {
    html = typeof renderMarkdown === "function" ? renderMarkdown(FV_PEEK.raw) : fvEsc(FV_PEEK.raw);
  } catch (_) {
    html = fvEsc(FV_PEEK.raw);
  }
  doc.innerHTML = html;
  scroller.appendChild(doc);
  renderFilePeekNote();
}

/* ── 视图：代码（行号槽 + 一行一块的高亮层）──
 * 行号与正文对齐只有「结构上同行同数」才靠得住，不靠像素去猜：
 *   · 高亮层按源文件逐行拆成 <span class="fp-l">（块级 = 一行占一块，空行也靠
 *     min-height 撑成整行），行号槽的行数直接取拆出来的块数；高亮器万一多吃
 *     或少吃一个换行，两边也不会错开；
 *   · 跳行标记 = 给那一块加 .cur（整行底色 + 左侧竖条），不再往正文里塞零宽
 *     哨兵、也不再算绝对定位的 top —— 那套做法有两个必错位的坑：行首那个
 *     inline-block 会把目标行的行盒撑高（它下面每一行都比行号低几 px），
 *     而 offsetTop / padding / 行高折算永远差那么一两 px。 */

/* 高亮输出是一整段 inline HTML，token 可以跨行（块注释 / 三引号 / 围栏代码）。
   按换行切成逐行片段：切到未闭合的 span 中间就先补 </span>，下一行开头原样重开，
   颜色不断行；行数严格等于 html.split("\n").length。 */
function fvHtmlToRows(html) {
  const s = String(html == null ? "" : html);
  const rows = [];
  const open = []; /* 当前还开着的 span class 栈 */
  let cur = "";
  const brk = () => {
    const held = open.slice();
    for (let k = held.length; k > 0; k--) cur += "</span>";
    rows.push(cur);
    cur = "";
    open.length = 0;
    for (const c of held) {
      open.push(c);
      cur += '<span class="' + c + '">';
    }
  };
  const re = /<[^>]*>|[^<]+/g;
  let m;
  while ((m = re.exec(s))) {
    const chunk = m[0];
    if (chunk.charAt(0) === "<") {
      cur += chunk;
      if (/^<\/?span/i.test(chunk)) {
        if (chunk.charAt(1) === "/") open.pop();
        else {
          const cm = /class="([^"]*)"/.exec(chunk);
          open.push(cm ? cm[1] : "");
        }
      }
      continue;
    }
    let rest = chunk;
    for (;;) {
      const nl = rest.indexOf("\n");
      if (nl < 0) {
        cur += rest;
        break;
      }
      cur += rest.slice(0, nl);
      brk();
      rest = rest.slice(nl + 1);
    }
  }
  for (let k = open.length; k > 0; k--) cur += "</span>";
  rows.push(cur);
  return rows;
}

/* ── 视图：编辑（行号槽 + 高亮镜像层 + 透明输入框）──
 * 编辑态不牺牲预览的观感：三层用的就是只读代码视图那一套 CSS ——
 *   · .fp-gutter            行号槽；
 *   · .fp-code.fp-mirror    高亮镜像层：同一份 fileviewHighlight、同一套 .jsl-* token，
 *                           逐行拆成 span.fp-l，与只读视图一行一块的结构完全一致；
 *   · .fp-editor            输入框：文字透明只留光标，压在上面那层镜像之上。
 * 三层共用 --fp-fs / --fp-lh / --fp-pad / --fp-cp 这一份度量，所以文字逐字对齐：
 * 光标落在哪儿，下面那层高亮就在哪儿。以前「进编辑就丢着色」是为了躲两层度量不一致
 * 导致的光标漂移，同源度量 + 透明文字把这个代价省回来。
 * 滚动只在输入框上发生（镜像层 / 行号槽都是 overflow:hidden），JS 同步 scrollTop / scrollLeft。
 * 重画按输入节流（FV_PEEK_EDIT_PAINT_MS）；大文件与只读视图同口径关掉着色只出纯文本。 */
const FV_PEEK_EDIT_PAINT_MS = 80;

/* 重画镜像层 + 行号槽。只写这两层的 innerHTML / textContent，绝不碰输入框里的正文，
   所以光标与选区一动不动。 */
function filePeekEditPaint() {
  const host = document.getElementById("filePeek");
  if (!host || !FV_PEEK.editing) return;
  const mirror = host.querySelector(".fp-mirror");
  const gutter = host.querySelector(".fp-gutter");
  const txt = String(FV_PEEK.editText == null ? "" : FV_PEEK.editText);
  const flat = txt.length > FV_PEEK_FLAT_BYTES;
  let rows = 0;
  if (mirror) {
    if (flat) {
      /* 与只读视图同口径：大文件关掉语法着色只出纯文本（纯文本一样逐行对齐） */
      mirror.textContent = txt;
    } else {
      const rs = fvHtmlToRows(fileviewHighlight(txt, FV_PEEK.lang));
      let buf = "";
      for (let i = 0; i < rs.length; i++) buf += '<span class="fp-l">' + rs[i] + "</span>";
      mirror.innerHTML = buf;
      rows = rs.length;
    }
  }
  if (gutter) {
    const n = flat ? (txt ? txt.split("\n").length : 0) : rows;
    let nums = "";
    for (let i = 1; i <= n; i++) nums += (i > 1 ? "\n" : "") + i;
    gutter.textContent = nums;
  }
  filePeekEditSyncScroll();
}

/* 输入框是唯一的滚动容器：镜像层与行号槽跟着它的 scrollTop / scrollLeft 走
   （两层都设了 overflow:hidden，程序化赋值照样生效，用户看不到第二条滚动条）。 */
function filePeekEditSyncScroll() {
  const host = document.getElementById("filePeek");
  if (!host) return;
  const ta = host.querySelector(".fp-editor");
  if (!ta) return;
  const mirror = host.querySelector(".fp-mirror");
  const gutter = host.querySelector(".fp-gutter");
  if (mirror) {
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
  }
  if (gutter) gutter.scrollTop = ta.scrollTop;
}

/* 连续输入时重画要节流：每敲一个字就重扫一遍全文（词法 + 拆行 + 建 DOM）打字会发涩 */
function filePeekEditPaintSoon() {
  if (FV_PEEK.paintTimer) return;
  FV_PEEK.paintTimer = setTimeout(() => {
    FV_PEEK.paintTimer = 0;
    filePeekEditPaint();
  }, FV_PEEK_EDIT_PAINT_MS);
}

function filePeekEditPaintNow() {
  if (FV_PEEK.paintTimer) {
    try {
      clearTimeout(FV_PEEK.paintTimer);
    } catch (_) {}
    FV_PEEK.paintTimer = 0;
  }
  filePeekEditPaint();
}

function renderFilePeekEditor() {
  const host = document.getElementById("filePeek");
  FV_PEEK.view = "edit";
  const scroller = host.querySelector("#fpScroll");
  scroller.innerHTML = "";
  scroller.className = "fp-scroll fp-vedit" + (FV_PEEK.wrap ? " fp-wrap" : "");
  /* 行号槽：与只读视图同一个 .fp-gutter（同一份度量、同一个 sticky 左贴），内容由 paint 填 */
  const gutter = document.createElement("pre");
  gutter.className = "fp-gutter";
  /* 代码列：镜像层与输入框严格同盒（position:absolute; inset:0），所以两层的换行宽度、内边距完全一致 */
  const cols = document.createElement("div");
  cols.className = "fp-edcols";
  const mirror = document.createElement("pre");
  mirror.className = "fp-code fp-mirror";
  mirror.setAttribute("aria-hidden", "true");
  const ta = document.createElement("textarea");
  ta.className = "fp-editor";
  ta.spellcheck = false;
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("autocorrect", "off");
  ta.value = String(FV_PEEK.editText || "");
  ta.addEventListener("input", () => {
    FV_PEEK.editText = String(ta.value == null ? "" : ta.value);
    filePeekEditPush();
    filePeekEditSync();
    filePeekEditPaintSoon();
  });
  ta.addEventListener("scroll", filePeekEditSyncScroll);
  ta.addEventListener("keydown", filePeekEditorKey);
  cols.appendChild(mirror);
  cols.appendChild(ta);
  scroller.appendChild(gutter);
  scroller.appendChild(cols);
  filePeekApplyEditorWrap(ta);
  renderFilePeekHead();
  renderFilePeekNote();
  filePeekEditPaint();
  try {
    ta.focus();
  } catch (_) {}
}

function renderFilePeekBody() {
  const host = document.getElementById("filePeek");
  const scroller = host.querySelector("#fpScroll");
  if (FV_PEEK.editing) {
    renderFilePeekEditor();
    return;
  }
  if (FV_PEEK.lang === "md" && !FV_PEEK.mdSrc) {
    renderFilePeekMd();
    renderFilePeekHead();
    return;
  }
  FV_PEEK.view = "code";
  const txt = String(FV_PEEK.raw || "");
  let lines = txt.split("\n");
  let extra = "";
  if (lines.length > FV_PEEK_MAX_LINES) {
    lines = lines.slice(0, FV_PEEK_MAX_LINES);
    extra +=
      (extra ? "；" : "") +
      I18n.t("只显示前 ") + FV_PEEK_MAX_LINES + I18n.t(" 行");
  }
  const flat = txt.length > FV_PEEK_FLAT_BYTES;
  if (flat) {
    extra +=
      (extra ? "；" : "") + I18n.t("文件较大，已关闭语法着色只出纯文本");
  }
  const src = lines.join("\n");
  const html = flat ? fvEsc(src) : fileviewHighlight(src, FV_PEEK.lang);
  /* 拆出来的块数 = 屏幕上真正的行数，行号与跳行都以它为准（不是以 txt 为准） */
  const rows = fvHtmlToRows(html);
  const jump = FV_PEEK.line >= 1 && FV_PEEK.line <= rows.length ? FV_PEEK.line : 0;

  scroller.className = "fp-scroll" + (FV_PEEK.wrap ? " fp-wrap" : "");
  scroller.innerHTML = "";
  const gutter = document.createElement("pre");
  gutter.className = "fp-gutter";
  let nums = "";
  for (let i = 1; i <= rows.length; i++) nums += (i > 1 ? "\n" : "") + i;
  gutter.textContent = nums;
  const code = document.createElement("pre");
  code.className = "fp-code";
  let buf = "";
  for (let i = 0; i < rows.length; i++) {
    buf +=
      '<span class="fp-l' + (i + 1 === jump ? " cur" : "") + '">' + rows[i] + "</span>";
  }
  code.innerHTML = buf;
  scroller.appendChild(gutter);
  scroller.appendChild(code);
  renderFilePeekHead();
  renderFilePeekNote(extra);
  if (jump) filePeekJumpTo(scroller, code, jump);
}

/* ============================================================
 * 三、工具按钮后方的文件名（原来叫「徽标」，现在只是纯文字，不给外框）
 * ------------------------------------------------------------
 * dshToolDetailsEl（app-assist.js）与 planLiveBlock（app-plan.js）共用这一份，
 * 两处只需把返回的元素挂到自己那颗「工具按钮」后面：
 *   · 挂在药丸外面（不放进 .dsh-tool-chip 里），否则看着像工具名的一部分；
 *   · 读=青 / 改=橙 / 目录=灰，正文只有文件名，无任何边框底色，hover 才给下划线；
 *   · 一条工具最多显 FV_BADGE_MAX 个，多余收成 +N：点 +N 就地展开成完整串
 *     （不叠第二个浮层，也不会把余下的文件只写进 title 却点不到）；
 *   · title 给模式 + 完整路径 + 本次读的行区间；
 *   · 点击 preventDefault + stopPropagation：只开面板，绝不触发 details 展开/收起。
 * 基准目录走三个真源现推（见 fileviewOwnerWorkspace），推不出就只显文件名、
 * 点击给一句提示 —— 不猜路径，避免把用户带到别的目录去。
 * ------------------------------------------------------------ */

const FV_BADGE_MAX = 3;
const FV_BADGE_MODE = { read: "读", write: "改", dir: "目录" };

/* 宿主第三参（nodeId）形状不统一：可能是画布/数据库节点 id、会话 st.id、
 * 镜像节点 live.id，也可能是助手那条字面量 "assist"。逐个真源试，全落空返回 ""。
 * 节点那份要过 devProjectRootOf（遍历整张图找开发块），而工具条每个 live tick
 * 都会把全部徽标重算一遍 —— 所以按 ownerId 缓 250ms，切工作区立刻生效不至于等到。 */
const FV_OWNER_WS_TTL = 250;
const FV_OWNER_WS_CACHE = new Map();
function fileviewOwnerWorkspace(ownerId) {
  const id = String(ownerId || "").trim();
  if (!id) return "";
  const hit = FV_OWNER_WS_CACHE.get(id);
  if (hit && Date.now() - hit.at < FV_OWNER_WS_TTL) return hit.ws;
  let ws = "";
  try {
    if (id === "assist" && typeof assistResolveWorkspace === "function") {
      ws = String(assistResolveWorkspace() || "");
    } else if (typeof nodeById === "function") {
      const n = nodeById(id);
      if (n && typeof dshWorkspaceOf === "function") ws = String(dshWorkspaceOf(n) || "");
    }
    if (!ws && id !== "assist" && typeof agentSessionById === "function") {
      const st = agentSessionById(id);
      if (st && typeof agentRunWorkspace === "function") ws = String(agentRunWorkspace(st) || "");
    }
  } catch (_) {
    ws = "";
  }
  if (FV_OWNER_WS_CACHE.size > 64) FV_OWNER_WS_CACHE.clear();
  FV_OWNER_WS_CACHE.set(id, { ws: ws, at: Date.now() });
  return ws;
}

function fvBadgeTitle(r) {
  const bits = [I18n.t(FV_BADGE_MODE[r.mode] || FV_BADGE_MODE.read)];
  bits.push(r.abs || r.path);
  /* read 的 offset / limit 直接进 title，省得用户点开才发现只读了半截 */
  if (r.line > 0) bits.push("L" + r.line + (r.count > 0 ? "×" + r.count : ""));
  return bits.join(" · ");
}

function fvBadgeEl(r) {
  const el = document.createElement("span");
  el.className = "dsh-tool-file m-" + (FV_BADGE_MODE[r.mode] ? r.mode : "read");
  el.textContent = r.name || r.path;
  el.title = fvBadgeTitle(r);
  el.setAttribute("role", "button");
  el.tabIndex = -1;
  el.addEventListener("click", (ev) => {
    /* summary 上的点击默认会展开/收起参数详情；徽标只要开面板 */
    ev.preventDefault();
    ev.stopPropagation();
    if (!fileviewPathIsOpenable(r.abs)) {
      toast(I18n.t("这个会话还没解析出工作目录，只给你看文件名"), "warn");
      return;
    }
    toggleFilePeek(r.abs, { mode: r.mode, line: r.line, count: r.count });
  });
  /* details 在 mousedown 阶段就会响应，鼠标按下也一并拦住 */
  el.addEventListener("mousedown", (ev) => ev.stopPropagation());
  el.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  return el;
}

/* 路径对比用（skip 名单 vs 徽标路径）：大小写、斜杠方向、结尾斜杠都不该让同一条路径被当成两条 */
function fvPathKey(p) {
  return String(p == null ? "" : p).trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/* 一条工具调用的全部徽标（含收成的 +N）。无文件 → 返回 null，调用方什么都不用挂。
 * skipPaths（可选）：摘要那一行已经写出来的路径（grep 的黄色目标路径），同一路径不再挂第二枚。 */
function dshToolFileBadges(t, ownerId, skipPaths) {
  if (!t || !t.name) return null;
  let refs;
  try {
    refs = toolFileRefsAbs(t, fileviewOwnerWorkspace(ownerId));
  } catch (_) {
    return null;
  }
  if (!refs || !refs.length) return null;
  if (skipPaths && skipPaths.length) {
    const skip = Object.create(null);
    for (const s of skipPaths) {
      const k = fvPathKey(s);
      if (k) skip[k] = 1;
    }
    refs = refs.filter((r) => !skip[fvPathKey(r.path)] && !skip[fvPathKey(r.abs)]);
    if (!refs.length) return null;
  }
  const frag = document.createDocumentFragment();
  const shown = refs.length > FV_BADGE_MAX ? refs.slice(0, FV_BADGE_MAX) : refs;
  for (const r of shown) frag.appendChild(fvBadgeEl(r));
  const rest = refs.length - shown.length;
  if (rest > 0) {
    const more = document.createElement("span");
    more.className = "dsh-tool-file fv-more";
    more.textContent = "+" + rest;
    const hidden = refs.slice(FV_BADGE_MAX);
    more.title =
      I18n.t("还有 ") + rest + I18n.t(" 个文件，点击展开") + "\n" +
      hidden.map((r) => (I18n.t(FV_BADGE_MODE[r.mode] || "读") + " · ") + (r.abs || r.path)).join("\n");
    more.setAttribute("role", "button");
    more.tabIndex = -1;
    /* 就地展开成完整徽标串：不叠第二个浮层，也不做「只写在 title 里却点不到」的假承诺 */
    more.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const parent = more.parentNode;
      if (!parent) return;
      for (const r of hidden) parent.insertBefore(fvBadgeEl(r), more);
      parent.removeChild(more);
    });
    more.addEventListener("mousedown", (ev) => ev.stopPropagation());
    frag.appendChild(more);
  }
  return frag;
}

/* 滚动定位：目标那一块就在那儿，量它相对滚动容器的位置即可，不做行高折算。
   code.children 里除了逐行的 .fp-l，还嵌着高亮用的 .jsl-* 子 span，
   所以要按 class 数到第 jump 个 .fp-l，不能直接下标取。 */
function filePeekJumpTo(scroller, code, jump) {
  const kids = code.children || [];
  let el = null;
  for (let i = 0, seen = 0; i < kids.length; i++) {
    const c = kids[i];
    if (!c.classList || !c.classList.contains("fp-l")) continue;
    seen++;
    if (seen === jump) {
      el = c;
      break;
    }
  }
  if (!el) return;
  try {
    const dy = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    /* 已经在视野里就别硬滚（用户可能正看着上面几行），只把目标行摆到偏上 1/3 处 */
    if (dy > 1 || dy < -1) scroller.scrollTop += dy - scroller.clientHeight * 0.35;
    if (!FV_PEEK.wrap) scroller.scrollLeft = 0;
  } catch (_) {}
}


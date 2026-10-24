"use strict";
/**
 * Remotion 主进程宿主：
 * - 数据目录 %APPDATA%/pipeline-console/remotion：config.json / installed.json / console.log / ui/
 * - install：选目录 → 复制 remotion-pack → npm install（remotion:progress 进度事件）
 * - status：安装目录 / runtimeReady（node_modules/remotion 存在）/ remotion 版本 / 渲染中
 * - render：写 src/Composition.tsx + src/index.tsx + render.json → spawn `node render.mjs`
 *   （Composition 优先用渲染层下发的 LLM 动效代码 params.tsx，无则回退内置标题卡模板）
 *   并解析其 JSON Lines 进度 → remotion:progress 事件 → 完成返回 { ok, outputPath }
 * - cancel：kill 渲染子进程
 * - removePluginMeta：仅移除数据目录入口（ui 等），保留安装目录
 * - 渲染前取 media-gen-global-lock 全局互斥（与 H3 / Music3 全局唯一音视频任务）
 * 全部参照 h3 模式：ensureUiRuntime 把 ui/ 复制到数据目录，控制台窗用独立 preload。
 */
const {
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  app,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync, execFile } = require("child_process");
const https = require("https");
/* 国内镜像源单一真源（pip / torch / 权重 / npm / git / chrome-for-testing）：见根目录 cn-mirrors.js */
const mirrors = require("../cn-mirrors.js");
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 指路），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");
/* 安装窗编排（主进程单例，见 plugins/main-install.js）：包内 install.ps1 的步骤行上报给它，
   窗口里逐步骤显示；失败就地给「交给 mtnode 会话修复」 */
const installHost = require("../plugins/main-install.js");
const stepReporter = require("../plugins/install-step-reporter.js");
/* 安装中断核心：取消 = 置 installCancel + 强杀当前安装脚本的进程树（见 plugins/install-cancel.js） */
const installKill = require("../plugins/install-cancel.js");
/* 插件安装后自检内核（结果落盘 / 等全局媒体锁 / 产物目录 / 进度上报全在它那儿，见 plugins/plugin-selfcheck.js）：
   本模块只在 require 期登记自己的 check（selfcheckMotion），不自己写盘、不自己发事件 */
const { registerPluginSelfcheck } = require("../plugins/plugin-selfcheck.js");
/* 一次性 TCP 探测（npm 源可达性）：环境自检里只用它，不下载任何东西 */
const net = require("net");
const {
  refreshStaleLock,
  tryAcquireLock,
  clearLock,
  releaseLock,
  busyMessage,
} = require("../media-gen-global-lock.js");

const PLUGIN_ID = "remotion";
/** 配套的安装 / 修复 skill 名（真源在仓库根 skills/<name>/SKILL.md，随包内置）。
 *  安装窗的「交给 mtnode 会话修复」与报错弹窗的修复会话都按它加载提示词。 */
const INSTALL_SKILL = "remotion-local-install";
/** 宿主生成的入口文件名与 render.json 里的相对路径（必须 .tsx：模板含 JSX） */
const ENTRY_BASENAME = "index.tsx";
const ENTRY_POINT = "src/" + ENTRY_BASENAME;
/** remotion-pack 脚手架体积提示（npm 依赖 + 渲染器，远小于模型后端） */
const DISK_HINT_GB = 8;
/** 渲染最长等待（默认 30 分钟） */
const RENDER_MAX_MS = 30 * 60 * 1000;
/** Remotion 4.0.518 钉的 Chrome Headless Shell 版本（读不到包内常量时的兜底，见 remotionChromeVersion） */
const CHROME_HEADLESS_SHELL_FALLBACK_VERSION = "149.0.7790.0";

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let consoleWin = null;
let installing = false;
let installCancel = false;
/* 当前这次安装的步骤上报器（runInstallScript 里 attach）：失败前的宿主级步骤行（环境预检 /
   脚手架缺失 / spawn 失败）都靠它递进安装窗 —— 脚本一行都没跑过的失败，也必须看得见。
   注意它只是「日志侧」的上报器：步骤行的解析仍由 install-step-reporter 负责。 */
let installRep = null;
/* 取 dsh 适配器（main.js 注入）：只为把安装 skill 同步进 dsh-home 供会话修复用 */
let getDsh = null;
/** @type {{ nodeId: string, child: import('child_process').ChildProcess|null, abort?: boolean, pct?: number, outputPath?: string }|null} */
let renderProc = null;

/* ------------------------------------------------------------------ */
/* 路径 / JSON 工具                                                    */
/* ------------------------------------------------------------------ */
function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function remotionRoot() {
  return mk(join(getDataDir(), "remotion"));
}

/**
 * 「自定义合成参数」的键值校验收口（通用：与「参数覆写」同一口径 —— 键只认正式名）。
 * 值只收 JSON 可表达的类型（字符串 / 数字 / 布尔 / 数组 / 对象 / null）。
 */
function sanitizeCustomProps(obj, warnings, label) {
  const out = {};
  if (obj == null) return out;
  if (typeof obj !== "object" || Array.isArray(obj)) {
    if (warnings) warnings.push((label || "customProps") + " 必须是一份 JSON 对象（{键: 值}），已忽略");
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || "").trim();
    if (!key) continue;
    const t = typeof v;
    if (v !== null && t !== "string" && t !== "number" && t !== "boolean" && t !== "object") {
      if (warnings) warnings.push((label || "customProps") + " 的「" + key + "」类型不支持，已忽略");
      continue;
    }
    if (t === "number" && !Number.isFinite(v)) {
      if (warnings) warnings.push((label || "customProps") + " 的「" + key + "」不是有限数字，已忽略");
      continue;
    }
    out[key] = v;
  }
  return out;
}

/**
 * 单值 → 规整后的 props 值（`键=值` 这种字符串写法时值可能是 JSON 字面量）。
 * 只认字符串 / 数字 / 布尔 / null：数组、对象这类复合值请写 JSON 文件或插件参数。
 */
function coerceScalar(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t) return "";
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  if (/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t === "null") return null;
  if (t[0] === "{" || t[0] === "[") {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }
  return t;
}

/**
 * 「自定义合成参数」：凡是带设置窗的节点，参数覆写里的**未知键**都会落到 node.pluginParams
 * （见 renderer/app-node-params.js 的 npApplyValues），这里把它当成合成的 props 传给模板。
 *
 * 为什么需要它（本工作流踩过的现场）：纯净 Remotion 插件只把 hero / narration / voice
 * 这三样按接线注入 inputProps，模板要的版式参数（底图 / 台词框边沿 / 循环帧数）没有通道，
 * 于是同一个「左角色 + 台词卡」模板在画布链路上永远拿不到参数，版式与循环都退化成兜底行为。
 * 这条通道与具体模板无关：remotion 节点、插件节点的 pluginParams 都能带任意 props。
 *
 * 解析顺序（后者覆盖前者）：
 *   ① params.pluginParams（节点「参数」里的未知键 / 插件自带参数）
 *   ② params.customProps
 *   ③ params.customPropsFile（相对路径按画布工作目录算；只读小 JSON，读不到就报警告）
 * 键以 `_` 开头的一律跳过（`_npStrict` 这类参数字段自己的运行期标记，不是合成参数）。
 */
function customPropsOf(params) {
  const p = params || {};
  const warnings = [];
  let out = {};
  const bag = sanitizeCustomProps(p.pluginParams, warnings, "pluginParams");
  if (Object.keys(bag).length) out = Object.assign(out, bag);
  const direct = sanitizeCustomProps(p.customProps, warnings, "customProps");
  if (Object.keys(direct).length) out = Object.assign(out, direct);

  const fp = String(p.customPropsFile || "").trim();
  if (fp) {
    const ws = String(p.workspace || "").trim();
    const abs = path.isAbsolute(fp) ? fp : path.resolve(ws || process.cwd(), fp);
    if (!fs.existsSync(abs)) {
      warnings.push("自定义合成参数文件不存在：" + abs);
    } else {
      try {
        const raw = fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw);
        const fromFile = sanitizeCustomProps(parsed, warnings, path.basename(abs));
        out = Object.assign(out, fromFile);
      } catch (e) {
        warnings.push("自定义合成参数文件不是合法 JSON（" + abs + "）：" + String((e && e.message) || e));
      }
    }
  }
  for (const k of Object.keys(out)) {
    if (k[0] === "_") delete out[k];
  }
  return { props: out, warnings };
}

/**
 * 已接线输入里声明的 props（**约定，不针对任何模板**）：
 *   · 某条文本输入整段就是一份 JSON 对象 → 它的键值进 props；
 *   · 每行 `键=值` → 进 props（值按 JSON 字面量解析：数字 / true / false / null；解析不了当字符串）。
 * 文本本身仍留在 texts 里（模板要读原文也不会因此丢掉）。
 */
/**
 * 接线里的「纯文本台词」→ narration。
 *
 *  为什么需要：propsFromInputs 只认 JSON 对象与 `键=值` 行，inlineMediaPropsOf 只认媒体；
 *  于是画布上「台词 → 端口 3」这种**直接接一段纯文本**的接法会被两边都跳过 ——
 *  渲染能跑完、动态层也在，但右侧台词卡整片空白（实测）。
 *  这里把「没被上面两条通道认领」的文本收下：含中文、不是媒体地址、不是单行键值对，
 *  多条就用空行拼接（合成层 pickNarrationFromTexts 会自己再筛一遍）。
 *  显式给了 narration 的不覆盖 —— 与 inlineMediaPropsOf 同一口径。
 */
function narrationFromInputs(inputs, existing) {
  const given = String((existing && existing.narration) || "").trim();
  if (given) return "";
  const parts = [];
  for (const it of Array.isArray(inputs) ? inputs : []) {
    const text = String((it && it.text) || "").trim();
    if (!text) continue;
    if (isMediaSrcString(text)) continue;
    if (text[0] === "{") {
      try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) continue; // 已被 propsFromInputs 认领
      } catch {
        /* 不是 JSON，按台词处理 */
      }
    }
    const rows = text.split(/\r?\n/).filter((r) => r.trim());
    const allPairs = rows.length > 0 && rows.every((r) => /^[A-Za-z_$][\w$.]*\s*[=:]\s*/.test(r.trim()));
    if (allPairs) continue; // 键=值 参数块，已被 propsFromInputs 认领
    /* 节拍表（序号 | 台词 | 起(s) | 止(s) | 时长）：已被 beatStartsFromInputs 认领成 lineStarts，
       不能再当台词拼进来 —— 整块都是表格行的直接跳过；顺手剔掉混在里面的表格行与「总时长:」行。 */
    const tableRows = rows.filter((r) => r.includes("|") || /^总时长\s*[:：]/.test(r.trim()));
    if (tableRows.length === rows.length) continue;
    const prose = rows
      .filter((r) => !r.includes("|"))
      .filter((r) => !/^总时长\s*[:：]/.test(r.trim()))
      .join("\n")
      .trim();
    if (!prose) continue;
    if (!/[\u4e00-\u9fa5]/.test(prose)) continue; // 台词是中文口播稿
    parts.push(prose);
  }
  return parts.join("\n").trim();
}

function propsFromInputs(inputs, warnings) {
  const out = {};
  for (const it of Array.isArray(inputs) ? inputs : []) {
    const text = String((it && it.text) || "").trim();
    if (!text || isMediaSrcString(text)) continue;
    if (text[0] === "{" && text.slice(-1) === "}") {
      try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const clean = sanitizeCustomProps(obj, warnings, "接线文本");
          if (Object.keys(clean).length) {
            Object.assign(out, clean);
            continue;
          }
        }
      } catch {
        /* 不是 JSON，继续按 `键=值` 试 */
      }
    }
    const pairs = {};
    let hit = 0;
    for (const row of text.split(/\r?\n/)) {
      const m = row.trim().match(/^([A-Za-z_$][\w$.]*)\s*[=:]\s*(.+)$/);
      if (!m) continue;
      pairs[m[1]] = coerceScalar(m[2]);
      hit++;
    }
    if (hit) Object.assign(out, pairs);
  }
  return out;
}

/**
 * 自定义合成也能拿到「可用的素材地址」（通用，与本工作流无关）。
 *
 * 背景：渲染内核禁止加载 file://，接线进来的本机路径在浏览器里必然失败；
 * 内置台词卡模板早已把它们内联成 data URL（见 resolveMediaSrc），但自定义合成分支
 * 之前只收 `键=值` 文本、把媒体串整条跳过 —— 于是「自己的合成 + 接一个视频」永远拿不到素材，
 * 只能靠人手把文件塞进工程 public/（换机器就失效）。这里把同一套内联口径补到自定义分支。
 *
 * 归位规则（与 pickPortraitInputs 一致）：视频 / 图片 → hero（视频优先），音频 → voice，
 * 图片在有视频时另作 poster。已显式给了同名键（节点参数或接线文本）的以显式值为准。
 */
function inlineMediaPropsOf(inputs, existing) {
  const given = Object.assign({}, existing || {});
  const list = (Array.isArray(inputs) ? inputs : [])
    .map((x) => ({index: Number((x && x.index) || 0), text: String((x && x.text) || "").trim()}))
    .filter((x) => x.index >= 0 && x.text)
    .sort((a, b) => a.index - b.index);

  const firstVideo = list.find((x) => isMediaSrcString(x.text) && mediaKindOfSrc(x.text) === "video");
  const firstImage = list.find((x) => isMediaSrcString(x.text) && mediaKindOfSrc(x.text) === "image");
  const firstAudio = list.find((x) => isMediaSrcString(x.text) && mediaKindOfSrc(x.text) === "audio");

  const out = {};
  const heroItem = firstVideo || firstImage;
  if (heroItem && !String(given.hero || "").trim()) {
    /* 按素材**实际类型**内联：只有图片时 hero 是图片，不能按 video 取 MIME（否则浏览器拒载） */
    const src = resolveMediaSrc(heroItem.text, mediaKindOfSrc(heroItem.text));
    if (src) out.hero = src;
  }
  if (firstAudio && !String(given.voice || "").trim()) {
    const src = resolveMediaSrc(firstAudio.text, "audio");
    if (src) out.voice = src;
  }
  /* 底图：视频与图片同时存在时，图片单独作为 poster（两者都要，不互斥）
     —— 图片保持 data URL：<Img> 不走 /proxy，data URL 对它是安全的 */
  if (firstImage && !String(given.poster || "").trim()) {
    const src = resolveMediaSrc(firstImage.text, "image");
    if (src) out.poster = src;
  }
  return out;
}

/* ══════════ 固化工程（多文件 file tree）+ 端子契约 ══════════════════════════
   渲染层在「构建」成功后把整棵工程源码（keys 相对 src/）与端子契约一起固化在节点上，
   运行时只把这份文件树交给这里写盘 → 渲染，**不再经过任何模型**。
   这里负责三件事：文件树消毒 / 逐文件导入解析校验 / 契约 → inputProps 组装。 */

/** 工程里允许的文件后缀（tsx/ts 是代码，css/json/md/txt 是资源与说明） */
const PROJECT_FILE_EXT = /\.(tsx|ts|jsx|js|css|json|md|txt)$/i;
/** 契约允许的端子类型（与渲染层 REMOTION_INPUT_KINDS 同一份） */
const CONTRACT_KINDS = ["image", "audio", "video", "text", "number", "boolean", "json"];

/** 工程相对路径消毒：只接受 src/ 下的相对路径（不许绝对路径 / .. / 反斜杠逃逸） */
function projectRelPath(raw) {
  const s = String(raw || "")
    .replace(/\\/g, "/")
    .trim();
  if (!s || s[0] === "/" || /^[A-Za-z]:/.test(s)) return "";
  if (/^data:|^https?:/i.test(s)) return "";
  const parts = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return "";
    parts.push(seg);
  }
  const rel = parts.join("/");
  if (!rel || !PROJECT_FILE_EXT.test(rel)) return "";
  return rel;
}

/** 相对 import → 工程里的真实文件（尝试补后缀 / index.*）；解析不到返回空串 */
function projectResolveImport(fromRel, spec, tree) {
  const baseDir = fromRel.indexOf("/") >= 0 ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const parts = baseDir ? baseDir.split("/") : [];
  for (const seg of String(spec || "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return "";
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const base = parts.join("/");
  if (!base) return "";
  const cands = [base];
  for (const e of ["tsx", "ts", "jsx", "js", "css", "json"]) cands.push(base + "." + e);
  for (const e of ["tsx", "ts", "jsx", "js"]) cands.push(base + "/index." + e);
  for (const c of cands) if (tree[c] != null) return c;
  return "";
}

/**
 * 校验整棵工程：入口存在 + 逐文件导入白名单 / 相对导入可解析 + 入口导出 Main + 契约可解析。
 * 容错口径与单文件一致：**没被用到的**非法 import 先剥掉（见 stripUnusedBadImports），
 * 仍在用的才硬失败（错误里点名文件，方便回灌给 agent 修）。
 * @returns {{ok:boolean, errors:string[], warnings:string[], files:object, contract:Array}}
 */
function validateProjectTree(rawFiles, entryRel) {
  const entry = String(entryRel || "Composition.tsx");
  const errors = [];
  const warnings = [];
  const files = {};
  const input = rawFiles && typeof rawFiles === "object" ? rawFiles : {};
  for (const [rawName, rawSrc] of Object.entries(input)) {
    const rel = projectRelPath(rawName);
    if (!rel) {
      errors.push("工程文件名不合法：" + String(rawName));
      continue;
    }
    if (typeof rawSrc !== "string") {
      errors.push("工程文件内容不是文本：" + rel);
      continue;
    }
    files[rel] = rawSrc;
  }
  if (!Object.keys(files).length) return { ok: false, errors: ["工程是空的（没有 src 文件）"], warnings, files, contract: [] };
  if (files[entry] == null) errors.push("工程缺少入口 " + entry);
  /* 逐文件：剥掉未使用的非法 import，剩下的逐个校验 */
  const treeNames = Object.keys(files);
  for (const rel of treeNames) {
    if (!/\.(tsx|ts|jsx|js)$/i.test(rel)) continue;
    let src = String(files[rel] || "");
    const fence = src.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/);
    if (fence) src = String(fence[1]).trim();
    try {
      src = stripUnusedBadImports(src).source;
    } catch {}
    files[rel] = src;
    for (const spec of collectImportSpecs(src)) {
      if (/^https?:/i.test(spec)) {
        errors.push(rel + " 里不允许远程 import：" + spec);
        continue;
      }
      if (CUSTOM_IMPORT_ALLOWED.test(spec)) continue;
      if (spec[0] === ".") {
        if (!projectResolveImport(rel, spec, files))
          errors.push(rel + " 里 import 的相对文件不存在：" + spec);
        continue;
      }
      errors.push(rel + " 里不许 import「" + spec + "」：只允许 react / remotion / 工程内相对文件");
    }
  }
  /* 入口必须导出 Main（验收口径与单文件一致：Main 或唯一大写具名导出自动别名） */
  if (files[entry] != null) {
    const norm = /export\s+(?:const|let|var|function|class)\s+Main\b/.test(files[entry])
      ? { source: files[entry], error: "" }
      : normalizeCustomComposition(files[entry]);
    if (norm.error) {
      errors.push(
        norm.error === "custom_tsx_no_main_export"
          ? entry + " 必须导出 Main（export const Main = ...，或 default 导出一个组件）"
          : entry + " 不合规：" + norm.error,
      );
    } else files[entry] = norm.source;
  }
  /* 端子契约：从**任意**文件里找 `export const inputs = [...]`（入口优先），只取一份 */
  let contract = [];
  let contractError = "";
  for (const rel of [entry, ...treeNames.filter((n) => n !== entry)]) {
    const raw = files[rel];
    if (!raw || !/\binputs\s*=/.test(raw)) continue;
    try {
      const parsed = parseContractLiteral(raw);
      if (parsed.error) {
        contractError = rel + " 的 inputs 契约解析失败：" + parsed.error;
        break;
      }
      if (parsed.list.length) {
        contract = normalizeContract(parsed.list);
        if (parsed.warnings.length) warnings.push(...parsed.warnings.map((w) => rel + "：" + w));
        break;
      }
    } catch (e) {
      contractError = rel + " 的 inputs 契约解析失败：" + String((e && e.message) || e);
      break;
    }
  }
  if (contractError) errors.push(contractError);
  if (!contract.length) warnings.push("没有 inputs 契约：运行时按老口径（hero / voice / narration）注入 props");
  return { ok: errors.length === 0, errors, warnings, files, contract };
}

/** 契约字段消毒：key 必须是合法标识符、kind 在枚举里；非法项丢弃并记警告 */
function normalizeContract(list) {
  const out = [];
  const seen = new Set();
  const warnings = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== "object") continue;
    const key = String(it.key || "").trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      warnings.push("端子 key 不合法（需为 JS 标识符）：" + key);
      continue;
    }
    if (seen.has(key)) {
      warnings.push("端子 key 重复，已忽略后一个：" + key);
      continue;
    }
    const kind = String(it.kind || "text").trim().toLowerCase();
    if (CONTRACT_KINDS.indexOf(kind) < 0) {
      warnings.push("端子「" + key + "」的 kind 不认识： " + kind + "（按 text 处理）");
    }
    seen.add(key);
    out.push({
      key,
      kind: CONTRACT_KINDS.indexOf(kind) >= 0 ? kind : "text",
      label: String(it.label || key),
      required: !!it.required,
      list: !!it.list,
    });
  }
  return out;
}

/** JS 对象/数组字面量解析（安全：不 eval；与渲染层 remotionParseLiteral 同一套语法） */
function parseContractLiteral(src) {
  const text = String(src || "");
  const at = text.search(/export\s+const\s+inputs\s*=\s*/);
  const start = at >= 0 ? text.indexOf("[", at) : text.indexOf("[");
  if (start < 0) return { list: [], warnings: [], error: "" };
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (text[i] === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      break;
    }
  };
  const str = () => {
    const q = text[i++];
    let out = "";
    while (i < text.length && text[i] !== q) {
      if (text[i] === "\\") {
        const n = text[i + 1];
        i += 2;
        out += n === "n" ? "\n" : n === "t" ? "\t" : n;
        continue;
      }
      out += text[i++];
    }
    if (text[i] === q) i++;
    return out;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (text[i] === "}") {
          i++;
          return obj;
        }
        if (i >= text.length) throw new Error("对象未闭合");
        let k;
        if (text[i] === '"' || text[i] === "'") k = str();
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
          if (!m) throw new Error("对象键不合法（位置 " + i + "）");
          k = m[0];
          i += k.length;
        }
        ws();
        if (text[i] !== ":") throw new Error("对象键后面缺少冒号");
        i++;
        obj[k] = value();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        throw new Error("对象里缺少逗号或右括号");
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (text[i] === "]") {
          i++;
          return arr;
        }
        if (i >= text.length) throw new Error("数组未闭合");
        arr.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        throw new Error("数组里缺少逗号或右括号");
      }
    }
    if (c === '"' || c === "'") return str();
    if (c === "`") {
      i++;
      let out = "";
      while (i < text.length && text[i] !== "`") out += text[i++];
      if (text[i] === "`") i++;
      return out;
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new Error("无法识别的值（位置 " + i + "）");
    i += m[0].length;
    if (m[0] === "true") return true;
    if (m[0] === "false") return false;
    if (m[0] === "null") return null;
    return Number(m[0]);
  };
  const list = value();
  return { list: Array.isArray(list) ? list : [], warnings: [], error: "" };
}

/** MIME → public/ 下的扩展名（渲染侧 parkedName 同一张表；主进程定名，render.mjs 只照写） */
function mediaExtOfMime(mime, kind) {
  const m = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const table = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/mpeg": ".mpeg",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
  };
  if (table[m]) return table[m];
  if (kind === "audio") return ".mp3";
  if (kind === "video") return ".mp4";
  return "";
}

/** 契约 key → public/ 下的安全文件名（不带扩展名） */
function mediaBaseName(key, index) {
  const base = String(key || "media").replace(/[^\w.-]/g, "_") || "media";
  return index == null || index < 0 ? base : base + "-" + (index + 1);
}

/**
 * 契约 → inputProps 组装（固化工程的唯一 props 通道）。
 *   · image：内联成 data URL（<Img> 不走 proxy，安全）
 *   · audio / video：**不内联**，交给 mediaBlobs 落 public/，props 里给 staticFile 用的裸文件名
 *   · list:true：值变成数组（媒体按接线顺序占位），标量取第一个
 *   · number/boolean/json：按字面量解析，解析不了原样给字符串
 * @returns {{props:object, mediaBlobs:object, mediaBlobsMeta:object, warnings:string[], audioFiles:string[]}}
 */
function contractPropsOf(params, contract) {
  const out = { props: {}, mediaBlobs: {}, mediaBlobsMeta: {}, warnings: [], audioFiles: [] };
  const inputs = Array.isArray(params && params.inputs) ? params.inputs : [];
  const byKey = new Map();
  const byIndex = new Map();
  for (const it of inputs) {
    if (!it) continue;
    const text = String(it.text == null ? "" : it.text).trim();
    if (!text) continue;
    const k = String(it.key || "").trim();
    if (k) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(it);
    }
    const idx = Number(it.index);
    if (isFinite(idx)) {
      if (!byIndex.has(idx)) byIndex.set(idx, []);
      byIndex.get(idx).push(it);
    }
  }
  for (let ci = 0; ci < contract.length; ci++) {
    const c = contract[ci];
    const items = (byKey.get(c.key) || byIndex.get(ci) || [])
      .slice()
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    const texts = items.map((x) => String(x.text == null ? "" : x.text).trim()).filter(Boolean);
    if (!texts.length) continue;
    if (c.kind === "image") {
      const imgs = [];
      for (const t of texts) {
        const src = resolveMediaSrc(t, "image");
        if (src) imgs.push(src);
      }
      if (imgs.length) out.props[c.key] = c.list ? imgs : imgs[0];
      continue;
    }
    if (c.kind === "audio" || c.kind === "video") {
      const names = [];
      texts.forEach((t, k) => {
        const idx = c.list ? k : -1;
        const src = resolveMediaSrc(t, c.kind);
        if (!src) {
          out.warnings.push("端子「" + c.key + "」的素材读不出来（" + mediaKindOfSrc(t) + "）：" + t.slice(0, 120));
          return;
        }
        if (/^https?:\/\//i.test(src)) {
          /* 远程地址：合成层可以直接用 URL，不必落地 */
          names.push(src);
          return;
        }
        const parsed = /^data:([^;,]+)[;,]/.exec(src);
        const mime = parsed ? parsed[1] : c.kind === "audio" ? "audio/mpeg" : "video/mp4";
        const comma = src.indexOf(",");
        if (!/^data:/i.test(src) || comma < 0) {
          out.warnings.push("端子「" + c.key + "」的素材不是 data URL（" + String(src).slice(0, 60) + "）");
          return;
        }
        const name = mediaBaseName(c.key, idx) + mediaExtOfMime(mime, c.kind);
        out.mediaBlobs[name] = src.slice(comma + 1);
        out.mediaBlobsMeta[name] = { mime, key: c.key, index: c.list ? k : -1, name };
        names.push(name);
      });
      if (!names.length) continue;
      out.props[c.key] = c.list ? names : names[0];
      if (c.kind === "audio") {
        for (const it of items) {
          const p = localMediaPathOf(String(it.text || "").trim());
          if (p) out.audioFiles.push(p);
        }
      }
      continue;
    }
    /* 文本与标量：第一个非空值（list 时全给） */
    const values = texts.map((t) => {
      if (c.kind === "number") {
        const n = Number(t.replace(/[^\d.eE+-]/g, ""));
        return isFinite(n) ? n : t;
      }
      if (c.kind === "boolean") return /^(true|1|yes|是|开)$/i.test(t);
      if (c.kind === "json") {
        try {
          return JSON.parse(t);
        } catch {
          return t;
        }
      }
      return t;
    });
    out.props[c.key] = c.list ? values : values[0];
  }
  return out;
}

/** 输入值若指向本机文件，返回绝对路径（音频时长探测用）；否则空串 */
function localMediaPathOf(text) {
  const s = String(text || "").trim();
  if (!s || /^data:/i.test(s) || /^https?:\/\//i.test(s)) return "";
  try {
    if (/^file:\/\//i.test(s)) return require("url").fileURLToPath(s);
  } catch {
    return "";
  }
  try {
    return fs.existsSync(s) ? path.resolve(s) : "";
  } catch {
    return "";
  }
}

/**
 * 该渲染走哪种合成（决定 props 怎么给）：
 *   builtin —— 内置台词卡模板（只认 hero / narration / voice / lineStarts / bg，多给的键它不读）；
 *   custom  —— 用户自己的合成代码（params.tsx，LLM 生成或节点里贴的）。
 * 口径与 writeRenderSources 完全一致：显式贴了代码就不再进内置模板。
 */
function renderModeOf(params) {
  const explicitTsx = String((params && params.tsx) || "").trim();
  if (explicitTsx) return "custom";
  /* 专属「台词卡」模板已移除：没有显式代码时一律按自定义合成走，
     不再因为描述里出现某个关键词、或接了媒体，就被切到内置版面。 */
  return "custom";
}
function configPath() {
  return join(remotionRoot(), "config.json");
}
function installedMetaPath() {
  return join(remotionRoot(), "installed.json");
}
function consoleLogPath() {
  return join(remotionRoot(), "console.log");
}
/** 随包脚手架：打包后取 resourcesPath/remotion-pack，开发时取项目根 remotion-pack */
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "remotion-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "remotion-pack");
}
function uiEntry() {
  const packed = join(remotionRoot(), "ui", "index.html");
  if (fs.existsSync(packed)) return packed;
  return join(__dirname, "ui", "index.html");
}

function readJson(p, fb) {
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

function defaultConfig() {
  return {
    installDir: "",
  };
}
function loadConfig() {
  return Object.assign(defaultConfig(), readJson(configPath(), {}) || {});
}
function saveConfig(partial) {
  const next = Object.assign(loadConfig(), partial || {});
  writeJson(configPath(), next);
  return next;
}

/* ------------------------------------------------------------------ */
/* 日志 / 广播                                                         */
/* ------------------------------------------------------------------ */
function appendConsole(line) {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.appendFileSync(p, String(line).replace(/\r?\n$/, "") + "\n", "utf8");
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) {
      const raw = fs.readFileSync(p, "utf8");
      fs.writeFileSync(p, raw.slice(-1024 * 1024), "utf8");
    }
  } catch {}
  broadcast("remotion:console", { line: String(line) });
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    } catch {}
  }
}

function emitProgress(ev) {
  broadcast("remotion:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
}

/**
 * 失败上报：控制台窗内的 toast 只有开着那只窗的人看得到。把同一次失败送到报错总线，
 * 让主窗口出一份带日志尾部的报告（总线内部吞异常，绝不影响主流程）。
 * 本宿主没有 Agent 自我修复（安装是 npm install），所以不注册隐藏的 selfRepair 回落入口：
 * 报告里的「🤖 自动修复」走渲染层那条看得见的会话（工作区 = usableInstallDir()），
 * 判成修好后由渲染层重跑报错节点收尾（remotion 无常驻服务）。
 * extra 一律带上 nodeId / nodeKind，报告才指得出是哪张卡住的节点。
 */
function reportErr(code, message, extra) {
  try {
    pluginErrors.reportPluginError(
      PLUGIN_ID,
      Object.assign({ code, message: String(message || "") }, extra || {}),
    );
  } catch {}
}

/**
 * 安装阶段上报的公共上下文：报告窗靠 nodeId 指认「修完重跑哪个节点」，
 * remotion 无常驻服务，渲染层那条收尾路径（app-repair.js）没有 nodeId 就只能提示用户手动重装。
 */
function installReportCtx(opts) {
  const o = opts || {};
  return {
    phase: "install",
    nodeId: String(o.nodeId || ""),
    workflowId: String(o.workflowId || ""),
    nodeKind: "remotion",
  };
}

/** 渲染阶段上报上下文：与 installReportCtx 同一口径，报告窗据此指认「修完重跑哪个节点」。 */
function renderReportCtx(params, nodeId) {
  const p = params || {};
  return {
    phase: "render",
    nodeId: String(nodeId || p.nodeId || ""),
    workflowId: String(p.workflowId || ""),
    nodeKind: "remotion",
  };
}

function consoleTail(maxBytes) {
  try {
    const p = consoleLogPath();
    if (!fs.existsSync(p)) return { ok: true, text: "" };
    const st = fs.statSync(p);
    const n = Math.min(st.size, Number(maxBytes) || 64 * 1024);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, Math.max(0, st.size - n));
    fs.closeSync(fd);
    return { ok: true, text: buf.toString("utf8") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 清空控制台日志：真删内容（truncate 到 0 字节）—— 保留文件与运行中后端持有的句柄；
    复位文件监控游标并广播 cleared，让打开着的日志窗就地清空。 */
function clearConsoleLog() {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.writeFileSync(p, "", "utf8");
    broadcast("remotion:consoleCleared", { at: Date.now() });
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 报错总线取「安装目录」：这个目录同时是渲染层「自动修复」会话的可写工作区（INSTALL_DIR），
 * 所以必须核对它的**可得性**，不能把配置里写过的字符串原样交出去 ——
 * 用户可能已经把目录删掉 / 换过盘，拿一个不存在的路径去修等于没有现场。
 * 口径：配置目录存在 → 用它；不存在或没配 → 回落数据目录 %APPDATA%/pipeline-console/remotion
 * （remotionRoot() 会顺手建出来，至少是一个能落盘、能看到 console.log 的真实现场）。
 */
function usableInstallDir() {
  const cfgDir = String(loadConfig().installDir || "").trim();
  if (cfgDir) {
    try {
      if (fs.existsSync(cfgDir)) return cfgDir;
    } catch {}
  }
  try {
    return remotionRoot();
  } catch {
    return cfgDir || "";
  }
}

/**
 * 注册后的一次性核对：把总线两个取现场入口（installDir / console.log）的实际可得性写进日志。
 * 出问题时先看这一行，就知道报告里为什么没有目录、或为什么日志尾部是空的。
 */
function auditReportBusSources() {
  const cfgDir = String(loadConfig().installDir || "").trim();
  let dirExists = false;
  try {
    dirExists = !!cfgDir && fs.existsSync(cfgDir);
  } catch {}
  const tail = consoleTail(4096);
  const usable = usableInstallDir();
  appendConsole(
    "[repair-bus] host=" +
      PLUGIN_ID +
      " installDir=" +
      (cfgDir || "(未设置)") +
      (cfgDir ? " exists=" + (dirExists ? 1 : 0) : "") +
      " reportDir=" +
      (usable || "(无)") +
      " runtimeReady=" +
      (usable && runtimeReadyAt(usable) ? 1 : 0) +
      " consoleLog=" +
      (tail && tail.ok ? "readable" : "unreadable:" + String((tail && tail.error) || "")),
  );
  if (!dirExists) {
    appendConsole(
      "[repair-bus] 安装目录不可得（多半是尚未「下载安装」）：报错报告改用数据目录作现场，修复前先补安装",
    );
  }
  return { installDir: cfgDir, dirExists, reportDir: usable, logOk: !!(tail && tail.ok) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* 目录安全 / 复制 / 磁盘                                              */
/* ------------------------------------------------------------------ */
function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  const resolved = path.resolve(raw);
  const norm = resolved.replace(/[/\\]+$/, "");
  const rootMatch = /^[a-zA-Z]:\\?$/.test(norm) || norm === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(norm);
  if (rootMatch) return { ok: false, error: "refuse_root" };
  const banned = [
    path.resolve("C:\\Windows"),
    path.resolve("C:\\Program Files"),
    path.resolve("C:\\Program Files (x86)"),
    path.resolve(process.env.SystemRoot || "C:\\Windows"),
  ];
  for (const b of banned) {
    if (norm.toLowerCase() === b.toLowerCase() || norm.toLowerCase().startsWith(b.toLowerCase() + path.sep)) {
      return { ok: false, error: "refuse_system" };
    }
  }
  return { ok: true, path: norm };
}

/* ------------------------------------------------------------------ */
/* 环境自检 / 预检（本轮：安装失败必须留下可复核的现场）                  */
/* ------------------------------------------------------------------ */
/* 为什么有这一段：安装窗开得出来、却「一条步骤行、一条日志都没有」的失败现场，
   根因是失败发生在**脚本跑起来之前**（随包脚手架 / install.ps1 缺失、node 不可用、
   目录没设或不可写），而那几处早退只发过报错总线，既没写 console.log，也没给安装窗
   任何步骤行。现在把它们统统变成：① console.log 有落盘的一行行现场；② 安装窗里有
   一个明确的失败步。日志真源仍然是 %APPDATA%\pipeline-console\<数据>\remotion\console.log。 */

/** 跑一个命令取版本（同步、超时短）：拿不到就回「不可用 + 原因」，绝不抛。
 *  **必须经 shell**：Windows 上 npm 是 `npm.cmd`，不经 shell 直接 spawnSync 会 EINVAL
 *  （与 runNpmInstall 那条注释同一个坑）；统一拼成单字符串，也不再触发 DEP0190。 */
function probeCommand(cmd, args) {
  const line = [cmd].concat(args || []).join(" ");
  try {
    const r = spawnSync(line, { encoding: "utf8", timeout: 10000, windowsHide: true, shell: true });
    const out = String((r && (r.stdout || r.stderr)) || "").trim().split(/\r?\n/)[0] || "";
    if (r && r.error) return { ok: false, value: "", detail: String((r.error && r.error.message) || r.error) };
    if (!r || r.status !== 0) {
      return {
        ok: false,
        value: "",
        detail: out || "exit " + String((r && r.status) || "?") + "（多半是 PATH 里没有 " + cmd + "）",
      };
    }
    return { ok: true, value: out, detail: out };
  } catch (e) {
    return { ok: false, value: "", detail: String((e && e.message) || e) };
  }
}

/** 目录可写吗：真的写一个探针文件再删掉（只看 existsSync 判不出只读盘 / 无权限）。 */
function probeWritable(dir) {
  const d = String(dir || "").trim();
  if (!d) return { ok: false, path: "", detail: "安装目录未设置" };
  const probe = join(d, ".mtnode-write-probe");
  try {
    mk(d);
    fs.writeFileSync(probe, "probe\n", "utf8");
    fs.rmSync(probe, { force: true });
    return { ok: true, path: d, detail: "可写" };
  } catch (e) {
    return { ok: false, path: d, detail: "不可写：" + String((e && e.message) || e) };
  }
}

/** 环境变量 / 默认值里的 npm registry（键名大小写在 Windows 上不敏感，逐个看）。 */
function npmRegistryOf() {
  const env = process.env || {};
  const keys = Object.keys(env);
  for (const k of keys) {
    if (k.toLowerCase() === "npm_config_registry" && String(env[k] || "").trim()) {
      return { url: String(env[k]).trim(), source: k };
    }
  }
  return { url: "https://registry.npmmirror.com", source: "默认（cn-mirrors.js：registry.npmmirror.com）" };
}

/** 一次性 TCP 探测（不下载任何东西）：npm 源在本机通不通。 */
function probeRegistryReachable(registry) {
  return new Promise((resolve) => {
    let url = null;
    try {
      url = new URL(String(registry || ""));
    } catch {
      return resolve({ ok: false, detail: "registry 不是合法 URL：" + String(registry || "") });
    }
    const host = url.hostname;
    const port = Number(url.port || (url.protocol === "http:" ? 80 : 443));
    const started = Date.now();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(Object.assign({ host, port, ms: Date.now() - started }, r));
    };
    let sock = null;
    try {
      sock = net.connect({ host, port });
    } catch (e) {
      return finish({ ok: false, detail: String((e && e.message) || e) });
    }
    sock.setTimeout(3000);
    sock.on("connect", () => {
      try {
        sock.destroy();
      } catch {}
      finish({ ok: true, detail: "可达（TCP " + host + ":" + port + "）" });
    });
    sock.on("timeout", () => {
      try {
        sock.destroy();
      } catch {}
      finish({ ok: false, detail: "连接超时（3s）：" + host + ":" + port + " 在本机不通" });
    });
    sock.on("error", (e) => finish({ ok: false, detail: String((e && e.message) || e) }));
  });
}

/** npm 命令名（Windows 上是 npm.cmd：它是 .cmd，spawn 必须经 shell 或不带扩展名） */
function npmCmdName() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * 环境自检 / 安装预检的**同一份实现**：把「装之前该有的一切」逐条查一遍。
 *   · 「Remotion 环境自检」按钮（remotion:selfcheck）→ 只出报告，不写日志文件（避免连点把日志刷满）；
 *   · 安装链的预检步 → 报告逐行写进 console.log 与安装窗，任一必需项不过就停在失败步。
 * items[].required=false 的项（磁盘余量、npm 源可达性）只提示、不拦安装：脚本自己会再判一次。
 */
async function environmentCheck(opts) {
  const o = opts || {};
  const cfgDir = String(loadConfig().installDir || "").trim();
  const dir = String(o.installDir || cfgDir || "").trim();
  const pack = bundledPackRoot();
  const scriptRel = join("scripts", "install.ps1");
  const scriptPath = join(dir || pack, scriptRel);
  const packScriptPath = join(pack, scriptRel);
  const reg = npmRegistryOf();
  const items = [];
  const push = (x) => items.push(Object.assign({ required: true, ok: false, key: "", label: "", detail: "" }, x));

  push({
    key: "app",
    label: "应用与平台",
    required: false,
    ok: true,
    detail:
      "v" +
      String((app && app.getVersion && app.getVersion()) || "?") +
      " · " +
      (app && app.isPackaged ? "已打包（发行版）" : "开发态（未打包）") +
      " · " +
      process.platform +
      "/" +
      process.arch +
      " · Electron " +
      String(process.versions.electron || "?") +
      " · 内置 Node " +
      String(process.versions.node || "?"),
  });

  const nodeProbe = probeCommand("node", ["--version"]);
  push({
    key: "node",
    label: "node（PATH 里的真 Node）",
    ok: nodeProbe.ok,
    detail: nodeProbe.ok ? nodeProbe.value : nodeProbe.detail,
    fix: "装 Node.js ≥18（建议 LTS）并确保新开的 PowerShell 里 node -v 有输出，然后重开 MTNode 再装。本应用自带的运行时不算。",
  });
  const npmProbe = probeCommand(npmCmdName(), ["--version"]);
  push({
    key: "npm",
    label: "npm",
    ok: npmProbe.ok,
    detail: npmProbe.ok ? npmProbe.value : npmProbe.detail,
    fix: "npm 随 Node.js 一起装（Windows 安装包默认带）。装完重开 MTNode。",
  });

  const safe = isSafeInstallDir(dir);
  if (!dir) {
    push({
      key: "install_dir",
      label: "安装目录",
      ok: false,
      detail: "未设置",
      fix: "在插件卡片 / 安装窗里点「选择安装目录」，选一个普通用户目录（如 D:\\mtnode\\remotion）后重试。",
    });
  } else {
    push({
      key: "install_dir",
      label: "安装目录",
      ok: safe.ok,
      detail: safe.ok ? dir : dir + "（" + humanizeInstallFailure(safe.error || "bad_dir").hint + "）",
      fix: humanizeInstallFailure(safe.error || "bad_dir").hint,
    });
  }

  if (dir && safe.ok) {
    const w = probeWritable(dir);
    push({
      key: "writable",
      label: "安装目录可写",
      ok: w.ok,
      detail: w.detail,
      fix: "换成当前用户可写的目录（不要选 C:\\Program Files、盘根或只读盘），或修好该目录的权限后重试。",
    });
  } else {
    push({
      key: "writable",
      label: "安装目录可写",
      ok: false,
      required: false,
      detail: "跳过（目录未设置或不合法）",
    });
  }

  let freeGb = null;
  try {
    freeGb = await freeDiskGb(dir || app.getPath("home"));
  } catch {}
  push({
    key: "disk",
    label: "磁盘余量",
    required: false,
    ok: freeGb == null ? true : freeGb >= DISK_HINT_GB,
    detail: freeGb == null ? "读不到（不拦安装）" : "剩余约 " + freeGb + "GB（建议 ≥" + DISK_HINT_GB + "GB）",
    fix: "清理磁盘，或换一个剩余空间足够的安装目录后重装（脚本可重跑，已下好的包会复用）。",
  });

  let regOk = true;
  let regDetail = reg.url + "（" + reg.source + "）";
  if (o.net !== false) {
    const r = await probeRegistryReachable(reg.url);
    regOk = !!r.ok;
    regDetail = reg.url + " · " + r.detail + "（来源：" + reg.source + "）";
  } else {
    regDetail = reg.url + "（来源：" + reg.source + "，未探测）";
  }
  push({
    key: "registry",
    label: "npm 源可达性",
    required: false,
    ok: regOk,
    detail: regDetail,
    fix: "换源重试：安装窗 / 脚本支持 -Official（官方源）与 -Registry <url>（自定义 / 公司内网源）。",
  });

  push({
    key: "pack",
    label: "随包脚手架",
    ok: !!fs.existsSync(pack),
    detail: pack + (fs.existsSync(pack) ? "" : "（不存在）"),
    fix: "随包脚手架缺失 = 应用安装包不完整（打包白名单漏项）：请重新安装 / 更新 MTNode 后再试。",
  });
  const stepsJson = join(pack, "steps.json");
  push({
    key: "pack_steps",
    label: "安装步骤表 steps.json",
    required: false,
    ok: fs.existsSync(stepsJson),
    detail: stepsJson + (fs.existsSync(stepsJson) ? "" : "（缺：安装窗左侧列不出步骤名）"),
    fix: "打包白名单漏项（build.json 的 remotion-pack 段）。开发态确认仓库里 remotion-pack/steps.json 存在。",
  });
  push({
    key: "install_script",
    label: "安装脚本 scripts\\install.ps1",
    ok: fs.existsSync(packScriptPath),
    detail: packScriptPath + (fs.existsSync(packScriptPath) ? "" : "（不存在：安装链根本没有脚本可跑）"),
    fix:
      "这是「安装失败且没有日志」的典型根因：build.json 的 remotion-pack 段必须放行 scripts/**，" +
      "否则装箱后的随包脚手架里没有安装脚本，宿主复制完就 spawn 失败，安装窗一条步骤行都不会有。",
  });
  push({
    key: "install_script_here",
    label: "工作区里的安装脚本",
    required: false,
    ok: fs.existsSync(scriptPath),
    detail: scriptPath + (fs.existsSync(scriptPath) ? "" : "（还没复制过去：安装开始时由宿主复制）"),
  });
  push({
    key: "runtime",
    label: "运行时（node_modules/remotion）",
    required: false,
    ok: runtimeReadyAt(dir),
    detail: runtimeReadyAt(dir)
      ? "已就位 v" + (remotionVersionAt(dir) || "?")
      : "未就位（未安装 / 装到一半）",
  });

  const bad = items.filter((x) => x.required && !x.ok);
  return { ok: bad.length === 0, at: Date.now(), installDir: dir, pack, items, bad: bad.map((x) => x.key) };
}

/** 自检报告 → 逐行文本（console.log 与安装窗日志用的是同一份）。 */
function formatEnvironmentReport(rep) {
  const r = rep || {};
  const lines = [];
  const mark = (x) => (x.ok ? "[ok]" : x.required ? "[FAIL]" : "[warn]");
  lines.push(
    "[selfcheck] Remotion 环境自检 " +
      new Date().toISOString() +
      " · " +
      (r.ok ? "通过" : "不通过（" + (r.bad || []).join(" / ") + "）"),
  );
  for (const it of r.items || []) {
    lines.push("[selfcheck] " + mark(it) + " " + it.label + "：" + it.detail);
    if (!it.ok && it.required && it.fix) lines.push("[selfcheck]        修法：" + it.fix);
  }
  return lines;
}

/**
 * 安装失败 → 人话。常见失败（缺 node/npm、目录缺 / 不合法、npm 源不通、磁盘不足、
 * 脚手架 / 脚本缺失）各给一句能照做的处置；认不出就如实说「看日志 / 交给会话修复」，不编根因。
 */
function humanizeInstallFailure(raw) {
  const s = String(raw || "");
  const table = [
    [
      /pack_missing/i,
      "随包脚手架 remotion-pack 不存在：应用安装包不完整（打包白名单漏项），请重新安装 / 更新 MTNode 后再试。",
    ],
    [
      /script_missing|install_script_missing/i,
      "随包脚手架里没有 scripts\\install.ps1：打包白名单漏了 scripts/**（这就是「安装失败且没有日志」的根因）。装箱后的包必须重新构建；开发态请确认仓库里 remotion-pack\\scripts\\install.ps1 存在。",
    ],
    [
      /empty_dir|bad_dir/i,
      "还没设置安装目录：在插件卡片 / 安装窗里选一个普通用户目录（如 D:\\mtnode\\remotion）后重试。",
    ],
    [
      /refuse_root/i,
      "安装目录选到了盘根（如 D:\\）：换一个子目录（如 D:\\mtnode\\remotion）后重试。",
    ],
    [
      /refuse_system/i,
      "安装目录落在系统目录（C:\\Windows / Program Files）：换一个普通用户目录后重试。",
    ],
    [
      /not found in PATH|node \/ npm|ENOENT.*node|spawn.*node/i,
      "本机 PATH 里没有可用的 node / npm：装 Node.js ≥18（建议 LTS）后重开 MTNode 再装（应用自带运行时不算）。",
    ],
    [
      /npm_exit_|npm ERR|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|EINVALIDTAGNAME|ERESOLVE/i,
      "npm 依赖安装失败：默认走 registry.npmmirror.com；源不通就换网络或改用 -Official / -Registry <url>，版本冲突就先删 node_modules 再重跑。",
    ],
    [
      /low_disk|磁盘/i,
      "磁盘剩余不足：清理磁盘或换一个空间足够的安装目录后重装。",
    ],
    [
      /runtime_missing/i,
      "npm install 没跑完（被中断 / 失败）：重跑安装即可续装，反复失败先删 node_modules。",
    ],
    [
      /cancelled|已取消/i,
      "安装是你主动取消的，不算故障：要装就再点一次安装。",
    ],
  ];
  for (const [re, hint] of table) {
    if (re.test(s)) return { code: s.split(":")[0].slice(0, 60), hint };
  }
  return { code: s.split(":")[0].slice(0, 60), hint: "认不出这一类失败：请把下面这份日志（含 [selfcheck] 段）交给会话修复，或到插件控制台跑一次「环境自检」。" };
}

/** 失败现场落盘：无论失败发生在哪一步，先把「这次要干什么 + 现场在哪」写进 console.log。 */
function logInstallFailure(phase, msg, ctx) {
  const c = ctx || {};
  const rep = installRep;
  if (rep) {
    try {
      rep.log("[install] failed phase=" + phase + " dir=" + String(c.installDir || "(未设置)"));
      rep.log("[install] pack=" + String(c.pack || ""));
      rep.log("[install] reason=" + String(msg || ""));
    } catch {}
  }
  const lines = [
    "[install] FAILED · phase=" + phase,
    "[install]   action=" + String(c.action || "install"),
    "[install]   plugin=" + PLUGIN_ID,
    "[install]   installDir=" + String(c.installDir || "(未设置)") + (c.dirExists ? "" : "（不存在）"),
    "[install]   packRoot=" + String(c.pack || "(未取到)") + (c.packExists === false ? "（不存在）" : ""),
    "[install]   installScript=" + String(c.script || "(未取到)") + (c.scriptExists === false ? "（不存在）" : ""),
    "[install]   reason=" + String(msg || ""),
    "[install]   hint=" + String(c.hint || ""),
    "[install]   log=" + consoleLogPath(),
  ];
  for (const l of lines) appendConsole(l);
  return lines;
}

/** 失败现场（给 logInstallFailure 用的结构）：路径一律先取好，判存在性失败就当不存在。 */
function installFailureCtx(o) {
  const x = o || {};
  const dir = String(x.installDir || "").trim();
  const safe = x.safe || isSafeInstallDir(dir);
  const pack = bundledPackRoot();
  const script = join(safe && safe.ok ? safe.path : dir, "scripts", "install.ps1");
  const existsSafely = (p) => {
    try {
      return !!p && fs.existsSync(p);
    } catch {
      return false;
    }
  };
  return {
    action: String(x.action || "install"),
    installDir: dir,
    dirExists: existsSafely(dir),
    pack,
    packExists: existsSafely(pack),
    script,
    scriptExists: existsSafely(script),
    hint: String(x.hint || ""),
  };
}

/** 给这次安装挂一个「日志侧」上报器：宿主自己的日志行（预检报告 / 失败现场）也要进安装窗。 */
function attachInstallReporter() {
  try {
    if (installRep && typeof installRep.isClosed === "function" && !installRep.isClosed()) return installRep;
  } catch {}
  const rep = stepReporter.attach({
    pluginId: PLUGIN_ID,
    child: null,
    onEvent: (ev) => installHost.reportPluginStep(ev),
  });
  installRep = rep;
  return rep;
}

/**
 * 脚本一行都没跑过时的显式失败步：直接给安装窗两条步骤行（开始 + 失败）。
 * 不这么做的话，脚本存在性 / spawn 这类失败在安装窗里就是「步骤表一动不动」——
 * 用户看不到任何东西，正是本轮要消掉的那种现场。
 */
function markHostStepFail(id, title, message, logLine) {
  const stepId = String(id || "host");
  const line = String(logLine || message || "");
  const emitFailStep = () => {
    try {
      installHost.reportPluginStep({
        pluginId: PLUGIN_ID,
        kind: "step",
        step: { id: stepId, title: String(title || ""), status: "run", message: line },
      });
      installHost.reportPluginStep({
        pluginId: PLUGIN_ID,
        kind: "step",
        step: { id: stepId, status: "fail", message: String(message || "") },
      });
    } catch {}
  };
  const rep = installRep;
  if (rep) {
    try {
      if (typeof rep.isClosed === "function" && !rep.isClosed()) {
        emitFailStep();
        return { ok: true, via: "step" };
      }
    } catch {}
  }
  /* 还没有上报器（失败发生在 attachInstallReporter 之前）：临时挂一只，断言完再收口 */
  const tmp = attachInstallReporter();
  emitFailStep();
  try {
    tmp.finish({ ok: false, error: String(message || "") });
  } catch {}
  installRep = null;
  return { ok: true, via: "temp" };
}

/** 写日志文件的同时，把这行推给安装窗的日志区（脚本没跑起来时的现场也要看得见）。 */
function appendInstallLog(line) {
  appendConsole(line);
  try {
    installHost.reportPluginStep({ pluginId: PLUGIN_ID, kind: "log", stepId: "preflight", line: String(line), stream: "host" });
  } catch {}
}

/** 宿主侧的「某一步成功」上报（脚本已经结束、宿主自己校验通过时用）。 */
function emitInstallStepOk(id, message, pct) {
  try {
    installHost.reportPluginStep({
      pluginId: PLUGIN_ID,
      kind: "step",
      step: { id: String(id || ""), status: "ok", message: String(message || ""), pct: Number(pct) || undefined },
    });
  } catch {}
}

/**
 * 把安装 skill 同步一份到本机 dsh-home（与兄弟宿主同一口径：先叫网关统一同步，
 * 网关不可用时自己从仓库根兜底拷一份）。修复会话靠它拿到现场口径的提示词。
 */
function syncRemotionInstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncInstallSkills === "function") dsh.syncInstallSkills();
    }
  } catch {}
  try {
    /* 兜底拷贝读仓库根的技能真源（与 llama / breeze 同一个写法：宿主目录不留副本） */
    const skillSrc = join(appRoot || path.join(__dirname, ".."), "skills", "remotion-local-install", "SKILL.md");
    const dshHome = join(getDataDir(), "dsh-home", "skills", "remotion-local-install");
    if (fs.existsSync(skillSrc)) {
      mk(dshHome);
      fs.copyFileSync(skillSrc, join(dshHome, "SKILL.md"));
      /* 与网关同步同一口径：安装技能写 .install-only，不进用户技能列表 / 工坊 */
      fs.writeFileSync(join(dshHome, ".install-only"), "1\n", "utf8");
    }
  } catch {}
}

function freeDiskGb(dir) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== "win32") return resolve(null);
      const drive = path.parse(path.resolve(dir)).root.replace(/\\/g, "");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-PSDrive -Name '${drive.replace(":", "")}').Free / 1GB`],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const n = parseFloat(String(stdout || "").trim());
          resolve(isFinite(n) ? Math.round(n * 10) / 10 : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || ["node_modules", ".git", "out", "output", "__pycache__"]);
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d, skip);
    else {
      mk(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}

function ensureUiRuntime() {
  const srcUi = join(__dirname, "ui");
  const destUi = join(remotionRoot(), "ui");
  if (!fs.existsSync(srcUi)) return;
  copyDirRecursive(srcUi, destUi, []);
}

/* ── 产物 take 编号：目标文件已存在时固定用 #1、#2 … 标「第几个 take」 ──
 *  旧版本固定贴 _1，且渲染层把改名后的路径写回节点，于是同一路径反复跑会叠成 foo_1_1_1。
 *  这里统一：先剥掉末尾的 take 标记（#N 认号，_N / _0N 当旧标记剥掉），
 *  再从「上一个号 + 1」起找第一个空号 —— 号只增不减，绝不叠加后缀。 */
function takeStemParts(stem) {
  let base = String(stem || "");
  let from = 0;
  for (let k = 0; k < 8; k++) {
    const hash = base.match(/#(\d+)$/);
    if (hash) {
      const n = Number(hash[1]);
      if (!from && n > 0) from = n;
      base = base.slice(0, -hash[0].length);
      continue;
    }
    const legacy = base.match(/_0*[1-9]\d{0,2}$/);
    if (legacy) {
      base = base.slice(0, -legacy[0].length);
      continue;
    }
    break;
  }
  return { base: base || String(stem || ""), from };
}

function uniqueFileInDir(dir, preferredName, defaultExt) {
  mk(dir);
  let name = String(preferredName || "").trim() || "out" + (defaultExt || "");
  const extMatch = name.match(/(\.[a-z0-9]+)$/i);
  const ext = (extMatch && extMatch[1]) || defaultExt || "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  const baseStem = stem || "out";
  if (!extMatch && ext) name = baseStem + ext;
  let dest = join(dir, name);
  if (!fs.existsSync(dest)) return { path: dest, filename: name, renamed: false };
  const tk = takeStemParts(baseStem);
  const head = tk.base || baseStem;
  for (let i = tk.from + 1; i < tk.from + 10000; i++) {
    const fn = head + "#" + i + ext;
    dest = join(dir, fn);
    if (!fs.existsSync(dest)) return { path: dest, filename: fn, renamed: true };
  }
  throw new Error("unique_filename_exhausted");
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */
function runtimeReadyAt(dir) {
  const root = String(dir || "").trim();
  if (!root || !fs.existsSync(root)) return false;
  return fs.existsSync(join(root, "node_modules", "remotion", "package.json"));
}

function remotionVersionAt(dir) {
  try {
    const pkg = readJson(join(String(dir || ""), "node_modules", "remotion", "package.json"), null);
    return String((pkg && pkg.version) || "") || "";
  } catch {
    return "";
  }
}

/**
 * npm install 进度解析：npm 不输出百分比，按里程碑推进 + 顺带解析行内 %。
 * 返回累计 pct（15→88 区间由调用方做上下限映射）。
 */
function parseNpmInstallLine(line, cur) {
  const s = String(line || "");
  const pctMatch = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) {
    const n = Number(pctMatch[1]);
    if (isFinite(n)) cur.pct = Math.max(cur.pct, Math.min(88, n));
  }
  if (/^added\s+\d+\s+packages?/i.test(s)) cur.pct = Math.max(cur.pct, 70);
  else if (/^changed\s+\d+\s+packages?/i.test(s)) cur.pct = Math.max(cur.pct, 72);
  else if (/up to date/i.test(s)) cur.pct = Math.max(cur.pct, 85);
  else if (/reify/i.test(s)) cur.pct = Math.max(cur.pct, 35);
  else if (/\badded\s+\d+\s+packages? in\b/i.test(s)) cur.pct = Math.max(cur.pct, 86);
  return s;
}

function runNpmInstall(installDir, nodeId) {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = ["install", "--no-audit", "--no-fund", "--loglevel=info"];
    appendConsole("$ " + npmCmd + " " + args.join(" "));
    /* Windows 的 .cmd 与 POSIX 的 npm shell 脚本都不是 PE/ELF 可执行文件，
       不经 shell 包装 spawn 会报 ERROR_BAD_EXE_FORMAT → spawn EINVAL（errno -4071）。
       因此统一走 shell:true，且拼成单字符串命令（避免 Node≥24 对
       "shell:true + 参数数组" 的 DEP0190 弃用告警）。 */
    const cmdline = [npmCmd, ...args]
      .map((a) => (/\s/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a))
      .join(" ");
    const child = spawn(cmdline, {
      shell: true,
      cwd: installDir,
      windowsHide: true,
      /* npm 默认走 registry.npmmirror.com（用户级覆盖见 ../cn-mirrors.js 的 MTNODE_NPM_REGISTRY） */
      env: Object.assign({}, process.env, mirrors.installEnv({ npm_config_progress: "true" })),
    });
    const cur = { pct: 15 };
    let out = "";
    const onData = (d, isErr) => {
      const s = d.toString();
      out += s;
      for (const rawLine of s.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        appendConsole((isErr ? "[err] " : "") + line);
        if (installCancel) return;
        parseNpmInstallLine(line, cur);
        emitProgress({
          phase: "install",
          nodeId,
          step: "npm",
          stepLabel: "安装依赖",
          message: line.slice(0, 120),
          pct: Math.max(15, Math.min(88, cur.pct)),
        });
      }
    };
    child.stdout.on("data", (d) => onData(d, false));
    child.stderr.on("data", (d) => onData(d, true));
    child.on("error", (e) => reject(new Error("npm_spawn: " + String((e && e.message) || e))));
    child.on("close", (code) => {
      if (installCancel) return reject(new Error("cancelled"));
      if (code !== 0) return reject(new Error("npm_exit_" + code + ": " + out.slice(-800)));
      resolve(out);
    });
  });
}

async function installProject(opts) {
  opts = opts || {};
  if (installing) {
    reportErr("busy", "Remotion 已有安装任务在跑，本次安装被拒", installReportCtx(opts));
    return { ok: false, error: "busy" };
  }
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) {
    /* 目录没配 / 不合法同样是安装失败出口：总线按码给指路文案（bad_dir / refuse_root / refuse_system）。
       本轮补上现场落盘与安装窗里的失败步 —— 这条早退以前只在总线里说了一句，用户手上既没有日志、
       安装窗也一条步骤行都没有（「安装失败且没有日志」的一半就是它）。 */
    const code = safe.error === "refuse_root" || safe.error === "refuse_system" ? safe.error : "bad_dir";
    reportErr(
      code,
      code === "bad_dir" && !String(cfg.installDir || "").trim()
        ? "Remotion 还没有设置安装目录：请先在「插件 · Remotion 动效视频」里选一个普通用户目录，再点「下载安装」"
        : "Remotion 安装目录不合法（盘根 / 系统目录一律拒绝），请在「插件 · Remotion 动效视频」里重选一个普通用户目录后重试",
      installReportCtx(opts),
    );
    /* 这一条以前不落盘：用户手上没有日志、安装窗也没有失败步。现在两处都有。 */
    const h = humanizeInstallFailure(safe.error || "bad_dir");
    const earlyCtx = installFailureCtx({ installDir: cfg.installDir, safe, hint: h.hint });
    attachInstallReporter();
    logInstallFailure("precheck", safe.error || "bad_dir", earlyCtx);
    markHostStepFail("precheck", "[环境预检] 安装目录不可用：" + String(cfg.installDir || "(未设置)"), h.hint);
    return { ok: false, error: safe.error || "bad_dir", hint: h.hint };
  }
  const installDir = safe.path;

  installing = true;
  installCancel = false;
  /* 本次失败的文案（finally 收口时用它，别再无条件把快照打成「install-aborted」掩盖真原因） */
  let failMsg = "";
  /* 本轮的现场：脚手架路径与安装脚本路径在整条链里都要能拿到 */
  let pack = "";
  let scriptPath = "";
  const existsFn = (p) => {
    try {
      return !!p && fs.existsSync(p);
    } catch {
      return false;
    }
  };
  /* 安装窗的会话由 remotion:install 入口先开（见 registerRemotionIpc），这里只管跑安装并上报步骤行 */
  attachInstallReporter();
  try {
    /* 建目录本身也可能失败（只读盘 / 权限）：放进 try 里，否则异常直接冒出 IPC，报告都不会有一份 */
    mk(installDir);
    emitProgress({
      phase: "install",
      step: "disk",
      stepLabel: "检查磁盘空间",
      message: `建议预留 ≥${DISK_HINT_GB}GB`,
      pct: 3,
    });

    /* 0) 环境预检（本轮新增）：node / npm、目录可写、磁盘、npm 源、随包脚手架与安装脚本 ——
       逐条写进 console.log 与安装窗日志。**必需项不过就停在预检失败步**：
       否则用户看到的就是「脚本跑都没跑，窗里一片空白」。 */
    const pre = await environmentCheck({ installDir });
    for (const line of formatEnvironmentReport(pre)) appendInstallLog(line);
    if (!pre.ok) {
      const preFail = (pre.items || []).filter((x) => x.required && !x.ok);
      const why = "preflight_failed: " + preFail.map((x) => x.key).join(" / ");
      const h0 = humanizeInstallFailure(why);
      const ctx0 = installFailureCtx({ installDir, safe, hint: h0.hint });
      /* 逐条把不过的项写进现场（「哪一项、具体是什么值」才算可复核） */
      for (const x of preFail) appendInstallLog("[preflight] " + x.key + " 不过：" + x.detail);
      logInstallFailure("precheck", why, ctx0);
      markHostStepFail(
        "preflight",
        "[环境预检] 未通过：" + preFail.map((x) => x.label).join(" / "),
        preFail.map((x) => x.detail + " → " + x.fix).filter(Boolean).join("；"),
      );
      reportErr("preflight_failed", why, installReportCtx(opts));
      installHost.finishPluginInstall({
        id: PLUGIN_ID,
        ok: false,
        error: why,
        hint: preFail[0] ? preFail[0].fix : h0.hint,
      });
      return { ok: false, error: "preflight_failed", bad: pre.bad, message: preFail.map((x) => x.label).join(" / ") };
    }
    const free = await freeDiskGb(installDir);
    if (free != null && free < DISK_HINT_GB && !opts.force) {
      reportErr(
        "low_disk",
        `磁盘剩余约 ${free}GB，建议预留 ≥${DISK_HINT_GB}GB（remotion 依赖 + 渲染器）`,
        installReportCtx(opts),
      );
      installHost.finishPluginInstall({
        id: PLUGIN_ID,
        ok: false,
        error: `磁盘剩余约 ${free}GB，建议预留 ≥${DISK_HINT_GB}GB`,
        hint: "磁盘剩余空间不足：清理磁盘，或在插件控制台换一个剩余空间足够的安装目录后重装。",
      });
      return {
        ok: false,
        error: "low_disk",
        freeGb: free,
        needGb: DISK_HINT_GB,
        message: `磁盘剩余约 ${free}GB，建议预留 ≥${DISK_HINT_GB}GB（remotion 依赖 + 渲染器）`,
      };
    }
    appendInstallLog(`disk free≈${free}GB (hint ≥${DISK_HINT_GB}GB)`);

    /* 1) 随包脚手架与安装脚本（本轮新增：这两处缺失以前没有任何步骤行、也没有日志） */
    pack = bundledPackRoot();
    /* 脚本先看**随包脚手架里那份**：真正的目录要等下面 copy 过去才有
       （以前这里写成看 installDir\scripts —— 第一次安装必然还没有，等于把正常安装也拦下来）。 */
    const packScriptPath = join(pack, "scripts", "install.ps1");
    const packMissing = !existsFn(pack);
    const scriptMissing = !existsFn(packScriptPath);
    const packCtx = installFailureCtx({ installDir, safe });
    if (packMissing || scriptMissing) {
      const why = packMissing ? "pack_missing: " + pack : "script_missing: " + packScriptPath;
      const h2 = humanizeInstallFailure(why);
      appendInstallLog(
        "[install] 脚手架核对：pack=" +
          pack +
          "（" +
          (packMissing ? "无" : "有") +
          "）· 随包安装脚本=" +
          packScriptPath +
          "（" +
          (scriptMissing ? "无" : "有") +
          "）",
      );
      emitProgress({
        phase: "install",
        step: "copy",
        stepLabel: "检查随包脚手架",
        message: h2.hint,
        pct: 6,
        error: true,
      });
      logInstallFailure("precheck", why, Object.assign(packCtx, { hint: h2.hint }));
      markHostStepFail("copy", "[环境预检] 随包脚手架不完整", h2.hint);
      reportErr(packMissing ? "pack_missing" : "script_missing", why, installReportCtx(opts));
      installHost.finishPluginInstall({ id: PLUGIN_ID, ok: false, error: why, hint: h2.hint });
      return { ok: false, error: packMissing ? "pack_missing" : "script_missing", message: h2.hint };
    }

    /* 2) 复制 remotion-pack → 安装目录 */
    emitProgress({
      phase: "install",
      step: "copy",
      stepLabel: "复制脚手架",
      message: "remotion-pack → " + installDir,
      pct: 10,
    });
    appendInstallLog("[install] copy pack " + pack + " → " + installDir);
    /* 复制前后的落地核对（失败时这两行就是现场：源在哪、目标里到底有什么） */
    try {
      appendInstallLog(
        "[install] 复制前：源 " +
          pack +
          " 有 " +
          fs.readdirSync(pack).length +
          " 项 · 目标 " +
          installDir +
          (fs.existsSync(installDir) ? " 已存在" : " 不存在"),
      );
    } catch (e1) {
      appendInstallLog("[install] 复制前核对失败：" + String((e1 && e1.message) || e1));
    }
    copyDirRecursive(pack, installDir, ["node_modules", ".git", "out", "output"]);
    appendInstallLog("[install] pack copied");
    /* 复制完核对：这次要看的是**工作区里**那份（脚本就在这儿被 spawn，缺了要当场指认复制结果） */
    scriptPath = join(installDir, "scripts", "install.ps1");
    if (!existsFn(scriptPath)) {
      let listed = "(目录读不到)";
      try {
        listed = fs.readdirSync(installDir).join(", ") || "(空目录)";
      } catch (e2) {
        listed = "(readdir 失败：" + String((e2 && e2.message) || e2) + ")";
      }
      appendInstallLog("[install] 复制后 " + installDir + " 里有：" + listed);
    }

    /* 3) 包内 install.ps1 逐步骤装依赖（node / npm → npm install → 校验），
       每一步一条结构化步骤行；卡片与安装窗都按它显示。原来的 runNpmInstall 保留给
       「运行时更新」等旧路径用，不再由安装链调用。 */
    emitProgress({
      phase: "install",
      step: "npm",
      stepLabel: "安装依赖",
      message: "npm install（remotion / react / @remotion/renderer）…",
      pct: 15,
    });
    if (!existsFn(scriptPath)) throw new Error("script_missing: " + scriptPath);
    await runInstallScript(scriptPath, installDir, !!opts.mirror);

    /* 3) 校验 runtimeReady + 版本 */
    emitProgress({
      phase: "install",
      step: "verify",
      stepLabel: "校验运行时",
      message: "检查 node_modules/remotion …",
      pct: 90,
    });
    /* 依赖步骤收口：脚本打的是它自己那份 JSON 步骤行，宿主这里再显式确认一次
       （快照终局要落成 done，不能只靠脚本最后那行） */
    emitInstallStepOk("npm", "依赖已就位", 92);
    if (!runtimeReadyAt(installDir)) {
      throw new Error("runtime_missing: node_modules/remotion 未找到（npm install 可能被中断）");
    }
    const version = remotionVersionAt(installDir) || "0.0.0";
    writeJson(installedMetaPath(), {
      ok: true,
      version,
      installDir,
      source: pack,
      installedAt: new Date().toISOString(),
    });
    appendConsole("[install] ok version=" + version + " dir=" + installDir);
    /* 顺手把渲染要用的 Chrome Headless Shell 从国内镜像预置好（失败不判安装失败：
       渲染那一刻会再试一次，并回退本机 Edge / Chrome）。 */
    try {
      const b = await ensureRenderBrowser(installDir);
      appendConsole("[install] browser " + b.how + (b.hint ? " · " + b.hint : ""));
    } catch (e) {
      appendConsole("[install] browser staging skipped: " + String((e && e.message) || e));
    }
    emitProgress({ phase: "install", step: "done", stepLabel: "完成", pct: 100 });
    installHost.finishPluginInstall({ id: PLUGIN_ID, ok: true });
    return { ok: true, installDir, version };
  } catch (e) {
    const msg = String((e && e.message) || e);
    failMsg = msg;
    /* 失败必落盘（本轮）：现场（动作 / 目录 / 脚手架 / 安装脚本路径 / 原因）先写进 console.log
       与安装窗日志，再谈失败步与建议 —— 这一行以前只有脚本自己跑起来过才有。 */
    const hFail = humanizeInstallFailure(msg);
    logInstallFailure(
      "install",
      msg,
      installFailureCtx({ installDir, safe, hint: hFail.hint, action: (opts && opts.action) || "install" }),
    );
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    /* 本轮口径：脚本失败**不再自动转 Agent 兜底**（那正是「看不见过程」的来源）。
       失败停在安装窗的失败步上，用户点「交给 mtnode 会话修复」才新建可见会话。 */
    /* 失败停在安装窗的失败步上；主窗口报错窗那一路仍照旧上报（remotion 没有 Agent 安装链） */
    installHost.finishPluginInstall({
      id: PLUGIN_ID,
      ok: false,
      error: msg === "cancelled" ? "安装已取消" : msg,
      hint: msg === "cancelled" ? "" : hFail.hint || stepReporter.hintFor(msg),
    });
    reportErr(msg, msg, installReportCtx(opts));
    return { ok: false, error: msg };
  } finally {
    installing = false;
    /* 收口只针对**真失败**的那次：成功路径的快照终局由 finishPluginInstall(ok:true) 写
       （日志侧上报器是宿主自己挂的，无条件 finish 会把 done 覆盖成 failed —— 本轮真踩到：
       步骤行全 ok、快照却 failed 且 error=install-aborted）。 */
    try {
      if (failMsg) {
        const snap = installHost.snapshotOf(PLUGIN_ID);
        const running = !!(snap && snap.state === "running");
        if (running && installRep && typeof installRep.isClosed === "function" && !installRep.isClosed()) {
          installRep.finish({ ok: false, error: failMsg });
        }
      }
    } catch {}
    installRep = null;
  }
}

/**
 * 跑 remotion-pack 的 install.ps1（本轮新增：原先安装链是宿主自己 spawn npm）。
 * 与兄弟宿主的 runPs 同一口径：stdout 每行进 console 并交给步骤上报器，取消 = installCancel。
 */
function runInstallScript(scriptPath, installDir, mirror) {
  return new Promise((resolve, reject) => {
    /* 日志侧上报器：脚本的每行输出除了落 console.log，也进安装窗日志区（步骤行仍由下面那只解析） */
    installRep = attachInstallReporter();
    const psArgs = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-InstallDir",
      installDir,
      "-SkipCopy",
    ];
    if (mirror) psArgs.push("-Mirror");
    appendConsole("$ powershell " + psArgs.join(" "));
    appendConsole(mirrors.banner("remotion install"));
    const child = spawn("powershell.exe", psArgs, {
      cwd: installDir,
      windowsHide: true,
      /* 统一国内源：npm_config_registry=registry.npmmirror.com（脚本里也默认走它） */
      env: Object.assign({}, process.env, mirrors.installEnv()),
    });
    /* 登记当前安装脚本：安装窗点「取消安装」时按进程树强杀它（否则脚本会一直跑到自己结束） */
    installKill.track(PLUGIN_ID, child);
    const rep = stepReporter.attach({
      pluginId: PLUGIN_ID,
      child,
      onEvent: (ev) => installHost.reportPluginStep(ev),
    });
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendInstallLog(line);
      }
      const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m) emitProgress({ phase: "install", step: "npm", stepLabel: "安装依赖", pct: 15 + Number(m[1]) * 0.7 });
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendInstallLog("[err] " + line);
      }
    });
    child.on("error", (e) => {
      installKill.untrack(PLUGIN_ID);
      rep.finish({ ok: false, error: String((e && e.message) || e) });
      reject(e);
    });
    child.on("close", (code) => {
      installKill.untrack(PLUGIN_ID);
      const cancelled = !!installCancel;
      rep.finish(
        cancelled
          ? { ok: false, cancelled: true, error: "cancelled" }
          : { ok: code === 0, error: code === 0 ? "" : "exit " + code },
      );
      if (cancelled) return reject(new Error("cancelled"));
      if (code !== 0) reject(new Error(`exit ${code}: ${out.slice(-800)}`));
      else resolve(out);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Chrome Headless Shell：国内镜像代下 + 预置，失败回退本机浏览器        */
/* ------------------------------------------------------------------ */
/**
 * 为什么需要这一块：Remotion 的浏览器下载直链是**硬编码**的 Google 存储地址
 * （chrome-for-testing-public，见 @remotion/renderer/dist/browser/get-chrome-download-url.js，
 * 没有任何环境变量可覆盖），
 * 国内常常直接超时 —— 表现是「插件装得上、一渲染就卡在 Downloading Chrome Headless Shell」。
 * 做法：先用 npmmirror 上同版本的 zip 代下，解到 Remotion 自己的缓存目录，并写好它认的
 * VERSION 文件（getBrowserStatus 判「目录存在 + 可执行文件存在 + VERSION === TESTED_VERSION」
 * 才跳过下载）；代下 / 解压失败才回退「探测本机 Edge / Chrome」并把路径交给 render.mjs。
 */
function remotionChromeVersion(installDir) {
  try {
    const p = path.join(
      installDir,
      "node_modules",
      "@remotion",
      "renderer",
      "dist",
      "browser",
      "get-chrome-download-url.js",
    );
    const src = fs.readFileSync(p, "utf8");
    const m = src.match(/TESTED_VERSION\s*=\s*['"]([0-9][0-9.]*)['"]/);
    if (m) return m[1];
  } catch {}
  return CHROME_HEADLESS_SHELL_FALLBACK_VERSION;
}

/** Remotion 的缓存布局：node_modules/.remotion/chrome-headless-shell/{VERSION,<platform>/chrome-headless-shell-<platform>/…} */
function chromeShellPaths(installDir) {
  const platform =
    process.platform === "win32"
      ? "win64"
      : process.platform === "darwin"
        ? process.arch === "arm64"
          ? "mac-arm64"
          : "mac-x64"
        : process.arch === "arm64"
          ? "linux-arm64"
          : "linux64";
  const base = path.join(installDir, "node_modules", ".remotion", "chrome-headless-shell");
  const folder = path.join(base, platform);
  const exe =
    platform === "win64"
      ? path.join(folder, "chrome-headless-shell-win64", "chrome-headless-shell.exe")
      : path.join(folder, "chrome-headless-shell-" + platform, "chrome-headless-shell");
  return { platform, base, folder, exe, versionFile: path.join(base, "VERSION") };
}

/** 本机 Chromium 系浏览器候选（代下失败时的兜底；Remotion 支持 browserExecutable 用系统浏览器渲染）。 */
function findLocalChromium() {
  const explicit = String(process.env.MTNODE_REMOTION_BROWSER_EXECUTABLE || "").trim();
  const cands = [];
  if (explicit) cands.push(explicit);
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || "";
  cands.push(
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
  );
  if (local) cands.push(path.join(local, "Google", "Chrome", "Application", "chrome.exe"));
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return "";
}

/** 下载到文件（跟随跳转），超时/网络错误 → reject。 */
function downloadToFile(url, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs || 120000 }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        downloadToFile(next, dest, timeoutMs).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error("http " + code));
        return;
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on("finish", () => ws.close(() => resolve(dest)));
      ws.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** 解压 zip（Windows 走 Expand-Archive；其它平台走 unzip）。 */
function extractZip(zipPath, destDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args =
      process.platform === "win32"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
           "Expand-Archive -LiteralPath " + JSON.stringify(zipPath) + " -DestinationPath " + JSON.stringify(destDir) + " -Force"]
        : ["-o", zipPath, "-d", destDir];
    const bin = process.platform === "win32" ? "powershell.exe" : "unzip";
    const child = spawn(bin, args, { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error("extract timeout"));
    }, timeoutMs || 180000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(destDir);
      else reject(new Error("extract exit " + code + ": " + err.slice(-300)));
    });
  });
}

/**
 * 确保渲染要用的浏览器就位。返回 { ok, how, browserExecutable?, version?, hint? }：
 *   how = "cache"（本地已有同版本缓存）· "mirror"（刚从 npmmirror 代下预置成功）
 *       · "local-browser"（代下失败，回退本机 Edge / Chrome）· "failed"
 */
async function ensureRenderBrowser(installDir) {
  const paths = chromeShellPaths(installDir);
  const version = remotionChromeVersion(installDir);
  try {
    if (fs.existsSync(paths.exe) && fs.readFileSync(paths.versionFile, "utf8").trim() === version) {
      return { ok: true, how: "cache", version };
    }
  } catch {}
  const zipUrl =
    mirrors.CHROME_FOR_TESTING_MIRROR +
    "/" +
    version +
    "/" +
    paths.platform +
    "/chrome-headless-shell-" +
    paths.platform +
    ".zip";
  const zipPath = path.join(installDir, "chrome-headless-shell-" + version + ".zip");
  try {
    appendConsole("[browser] 从国内镜像代下 chrome-headless-shell " + version + "：" + zipUrl);
    mk(paths.folder);
    await downloadToFile(zipUrl, zipPath, 120000);
    await extractZip(zipPath, paths.folder, 180000);
    if (!fs.existsSync(paths.exe)) throw new Error("exe_missing_after_extract: " + paths.exe);
    /* macOS / Linux 上 zip 不保留可执行位，Remotion 自己下载时会 makeExecutable，这里手动补一次 */
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(paths.exe, 0o755);
      } catch {}
    }
    /* VERSION 必须与 Remotion 期望值逐字符相同，否则它判 version-mismatch 又去撞官方直链 */
    fs.writeFileSync(paths.versionFile, version + "\n");
    try {
      fs.unlinkSync(zipPath);
    } catch {}
    appendConsole("[browser] 已预置到 " + paths.exe + "（Remotion 不再下载）");
    return { ok: true, how: "mirror", version };
  } catch (e) {
    const why = String((e && e.message) || e);
    try {
      fs.unlinkSync(zipPath);
    } catch {}
    const local = findLocalChromium();
    appendConsole(
      "[browser] 国内镜像代下失败（" +
        why +
        "）" +
        (local
          ? " → 回退用本机浏览器渲染：" + local + "（Remotion 会警告：非它钉版的浏览器，渲染确定性略降）"
          : " → 本机也没找到 Edge / Chrome"),
    );
    if (local) return { ok: true, how: "local-browser", version, browserExecutable: local };
    return {
      ok: false,
      how: "failed",
      version,
      hint:
        "渲染需要 Chrome Headless Shell（约 170MB）：国内镜像 " +
        mirrors.CHROME_FOR_TESTING_MIRROR +
        "/" +
        version +
        "/" +
        paths.platform +
        "/chrome-headless-shell-" +
        paths.platform +
        ".zip 下载失败，且本机没有 Edge / Chrome。请联网重试，或装 Edge/Chrome 后重跑渲染。",
    };
  }
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
async function statusForUi() {
  const cfg = loadConfig();
  const meta = readJson(installedMetaPath(), null);
  const installDir = cfg.installDir || "";
  const runtimeReady = runtimeReadyAt(installDir);
  const version =
    remotionVersionAt(installDir) || String((meta && meta.version) || "") || "";
  const rendering = !!(renderProc && renderProc.child);
  return {
    ok: true,
    id: PLUGIN_ID,
    installDir,
    installed: !!(meta && meta.ok) || runtimeReady,
    runtimeReady,
    version,
    rendering,
    renderState: renderProc
      ? {
          nodeId: renderProc.nodeId || "",
          pct: Number(renderProc.pct) || 0,
          outputPath: renderProc.outputPath || "",
        }
      : null,
    installing,
    lock: refreshStaleLock(),
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    consolePath: consoleLogPath(),
  };
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/**
 * 渲染模板：src/Composition.tsx（可编辑的通用模板：背景色 + 可选全屏图 + 标题/副标题
 * 淡入动画，帧号驱动）。参数以 CFG 内联 JSON 嵌入，单文件自洽。
 */
function buildCompositionSource(params) {
  const width = Number(params.width) || 1280;
  const height = Number(params.height) || 720;
  const fps = Number(params.fps) || 30;
  const duration = Math.max(1, Math.round(Number(params.durationSeconds) || 5));
  const durationInFrames = Math.max(1, Math.round(duration * fps));
  const cfg = {
    width,
    height,
    fps,
    durationInFrames,
    backgroundColor: params.backgroundColor || "#0f1218",
    title: String(params.title || ""),
    subtitle: String(params.subtitle || ""),
    images: Array.isArray(params.images)
      ? params.images.filter((p) => p && typeof p === "string")
      : params.image
        ? [params.image]
        : [],
    audioPath: params.audioPath || "",
  };
  return `import React from "react";
import {
  AbsoluteFill,
  Img,
  Audio,
  useCurrentFrame,
  interpolate,
  spring,
} from "remotion";

export const CFG: {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  backgroundColor: string;
  title: string;
  subtitle: string;
  images: string[];
  audioPath: string;
} = ${JSON.stringify(cfg, null, 2)};

export const Main: React.FC = () => {
  const frame = useCurrentFrame();
  /* durationInFrames=1 时 inputRange 会退化为 [0,0]，Remotion 校验要求 inputRange 严格递增，
     直接报 "inputRange must be strictly monotonically increasing"，此时跳过淡入恒为 1 */
  const fadeIn =
    CFG.durationInFrames <= 1
      ? 1
      : interpolate(frame, [0, Math.min(20, CFG.durationInFrames - 1)], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const pop = spring({ frame, fps: CFG.fps, config: { damping: 12 } });
  const bg = CFG.images[0] || "";
  return (
    <AbsoluteFill
      style={{
        width: CFG.width,
        height: CFG.height,
        backgroundColor: CFG.backgroundColor,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, 'Microsoft YaHei', sans-serif",
      }}
    >
      {bg ? (
        <Img
          src={bg}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: fadeIn,
          }}
        />
      ) : null}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          padding: 48,
        }}
      >
        {CFG.title ? (
          <div
            style={{
              color: "#fff",
              fontSize: Math.max(28, Math.round(CFG.width * 0.055)),
              fontWeight: 700,
              transform: \`scale(\${0.92 + pop * 0.08})\`,
              opacity: fadeIn,
              textShadow: "0 4px 24px rgba(0,0,0,.55)",
            }}
          >
            {CFG.title}
          </div>
        ) : null}
        {CFG.subtitle ? (
          <div
            style={{
              color: "rgba(255,255,255,.85)",
              fontSize: Math.max(16, Math.round(CFG.width * 0.024)),
              marginTop: 18,
              opacity: fadeIn,
            }}
          >
            {CFG.subtitle}
          </div>
        ) : null}
      </AbsoluteFill>
      {CFG.audioPath ? <Audio src={CFG.audioPath} /> : null}
    </AbsoluteFill>
  );
};
`;
}

/** 自定义合成的依赖白名单：安装目录只装了 react / remotion，其它包打包必失败 */
const CUSTOM_IMPORT_ALLOWED = /^(?:react|remotion)(?:\/|$)/;

/* 注：「角色动态 + 台词卡」专用内置模板（portrait-dialogue.tsx）连同它的
   wantsBuiltinDialogue / pickPortraitInputs 已在引擎侧移除 —— 那套是给单一工作流定制的，
   会让「描述里出现台词卡」或「接了媒体」的画布绕过通用合成口径。
   现在一律走通用链路：有显式 tsx / 节点描述就走自定义合成，否则内置标题卡模板。 */
const DATA_URL_RE = /^data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i;

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif)$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;

const MIME_OF_EXT = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

/** 一条输入是不是「干净」的媒体地址（data URL / 本机路径 / http） */
function isMediaSrcString(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  if (DATA_URL_RE.test(s)) return true;
  if (s.indexOf("\n") >= 0) return false;
  if (/^https?:\/\//i.test(s))
    return /\.(mp4|webm|mov|m4v|png|jpe?g|webp|mp3|wav|flac|m4a)(\?|$)/i.test(s);
  return VIDEO_EXT_RE.test(s) || IMAGE_EXT_RE.test(s) || AUDIO_EXT_RE.test(s);
}

function mediaKindOfSrc(v) {
  const s = String(v || "").trim();
  const m = s.match(/^data:([a-z]+)\//i);
  if (m) return m[1].toLowerCase();
  if (VIDEO_EXT_RE.test(s)) return "video";
  if (IMAGE_EXT_RE.test(s)) return "image";
  if (AUDIO_EXT_RE.test(s)) return "audio";
  return "";
}

/**
 * 本机路径 → data URL（打包后的渲染页取不到 file:// 路径；data: 内联是应用里同一套做法）。
 * 超过上限或读不到时返回空串，由调用方回退原路径。
 */
function dataUrlOfLocal(pathStr, maxMb) {
  const p = String(pathStr || "").trim();
  if (!p || !fs.existsSync(p)) return "";
  try {
    const st = fs.statSync(p);
    const cap = Math.max(1, Number(maxMb) || 32) * 1024 * 1024;
    if (!st.isFile() || st.size > cap) return "";
    const mime = MIME_OF_EXT[path.extname(p).toLowerCase()] || "application/octet-stream";
    return "data:" + mime + ";base64," + fs.readFileSync(p).toString("base64");
  } catch {
    return "";
  }
}

/** 媒体输入取「可用地址」：data URL 原样；本机媒体文件必须内联成 data URL。
 *  渲染内核（Remotion headless Chrome）禁止加载 file:// 本地资源（实测报
 *  "Not allowed to load local resource"），所以内联失败时**不能**回退成本机路径，
 *  否则左侧会静默变成黑屏；这里返回空串，由调用方给出可行动的报错。 */
function resolveMediaSrc(pathStr, type) {
  const s = String(pathStr || "").trim();
  if (!s) return "";
  if (/^data:/i.test(s) || /^https?:\/\//i.test(s)) return s;
  const capMb = type === "video" ? 32 : type === "audio" ? 16 : 12;
  return dataUrlOfLocal(s, capMb);
}

/* 注：专属的 pickPortraitInputs 已随「台词卡」内置模板一并移除；
   素材归位改由通用的 inlineMediaPropsOf 负责（视频 / 图片 → hero，音频 → voice，图片另作 poster）。 */

/** 逐字打字节拍：从已接线的文本输入里找「台词节拍表」，解析成每句起帧。
 *  认两种形态（与渲染侧 remotionBeatStarts 同口径）：
 *    ① 表格行 `序号 | 台词原文 | 起(s) | 止(s) | 时长(s)`（台词节拍节点 proc_text 的输出）
 *    ② 时间码行 `0.0s  台词原文`
 *  取所有文本输入里 parsed 出 ≥2 句的那一条（台词正文本身解析不出，不会误认）。 */
function beatStartsFromInputs(texts, fps) {
  const f = Math.max(1, Number(fps) || 30);
  let best = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    const starts = [];
    for (const row of String(text || "").split(/\r?\n/)) {
      const line = row.trim();
      if (!line) continue;
      let sec = NaN;
      if (line.includes("|")) {
        const cells = line.split("|").map((s) => s.trim());
        if (cells.length >= 4) sec = parseFloat(cells[cells.length - 3]);
      } else {
        const m = line.match(/^(\d+(?:\.\d+)?)\s*s\b/i);
        if (m) sec = parseFloat(m[1]);
      }
      if (isFinite(sec) && sec >= 0) starts.push(Math.round(sec * f));
    }
    if (starts.length > best.length) best = starts;
  }
  return best.length >= 2 ? best : [];
}


/** 文件内是否声明过该标识名（default 导出别名前的防误判） */
function declaredHere(src, name) {
  const re = new RegExp(
    "^[ \\t]*(?:export[ \\t]+)?(?:const|let|var|function|class)[ \\t]+" + name + "\\b",
    "m",
  );
  return re.test(src);
}

/**
 * 把 remotion 渲染子进程的原始错误翻译成可定位、可行动的中文指引。
 * 主要针对 LLM 动效代码最常见的运行时错误：interpolate 的 inputRange 关键帧数组
 * 出现重复值 / 倒序（如 [220,280,280]），Remotion 校验直接抛错（错误栈 in Array.map）。
 */
function friendlyRenderError(err, usingCustom) {
  const s = String(err || "");
  const m = s.match(
    /inputRange must be strictly monotonically increasing but got \[([^\]]*)\]/,
  );
  if (m) {
    return (
      "动效代码渲染失败：interpolate() 的关键帧数组 inputRange 必须严格递增且元素不重复，" +
      "但收到 [" +
      m[1] +
      "]。\n" +
      "请检查 Main 组件中所有 interpolate(frame, inputRange, ...) 的 inputRange：\n" +
      "· 删掉重复 / 乱序的帧号（如 [220,280,280] 改成 [220,280] 或 [220,280,340]）；\n" +
      "· 在 map / 循环里用 i 计算关键帧时，后一个帧号必须严格大于前一个" +
      "（例如 [140+i*10, 200+i*10, Math.max(280, 220+i*10)] 用 Math.max 兜底，避免 i 增大后与固定帧重复或倒序）；\n" +
      "· 可在节点 💬 会话中把这段报错发给智能体直接修复，或重跑节点重新生成动效代码。"
    );
  }
  return s;
}

/** 模块说明符是否在白名单内（react / remotion 与相对路径放行） */
function customImportAllowed(spec) {
  const s = String(spec || "");
  return s[0] === "." || s[0] === "/" || CUSTOM_IMPORT_ALLOWED.test(s);
}

/** 扫出源码里全部模块说明符（静态 import / require() / 动态 import()) */
function collectImportSpecs(src) {
  const specs = [];
  const push = (s) => {
    if (s && specs.indexOf(s) < 0) specs.push(s);
  };
  let m;
  const reStatic = /(?:^|[\s;{}])import\s[^'"`]*?['"]([^'"]+)['"]/g;
  while ((m = reStatic.exec(src))) push(m[1]);
  const reCall = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reCall.exec(src))) push(m[1]);
  return specs;
}

/** import 子句里的本地绑定名：default / { a, b as c } / * as ns */
function importBindingNames(clause) {
  let s = String(clause || "").replace(/^\s*import\s+/, "").replace(/^type\s+/, "").trim();
  const names = [];
  const braces = s.match(/\{([\s\S]*?)\}/);
  if (braces) {
    for (const part of String(braces[1]).split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      names.push((as ? as[1] : t.replace(/^type\s+/, "")).trim());
    }
    s = s.replace(/\{[\s\S]*?\}/, "");
  }
  const star = s.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
  if (star) names.push(star[1]);
  const def = String(s.split(",")[0] || "").replace(/^type\s+/, "").trim();
  if (/^[A-Za-z_$][\w$]*$/.test(def)) names.push(def);
  return names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

/** 解构 / 标识符左边（require 的赋值目标）里的本地绑定名 */
function requireBindingNames(lhs) {
  const s = String(lhs || "").trim();
  const names = [];
  const braces = s.match(/\{([\s\S]*?)\}/);
  if (braces) {
    for (const part of String(braces[1]).split(",")) {
      const t = part.trim();
      if (!t) continue;
      const colon = t.match(/^[^:]+:\s*([A-Za-z_$][\w$]*)/);
      names.push((colon ? colon[1] : t).trim());
    }
  }
  const plain = s.replace(/\{[\s\S]*?\}/, "").replace(/^,|,$/g, "").trim();
  if (/^[A-Za-z_$][\w$]*$/.test(plain)) names.push(plain);
  return names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

/** 这些绑定的名字在「去掉这条语句后的源码」里还有没有被引用 */
function anyBindingUsed(restSrc, names) {
  return (names || []).some(
    (n) => n && new RegExp("(^|[^\\w$.])" + n.replace(/\$/g, "\\$") + "($|[^\\w$])").test(restSrc),
  );
}

/**
 * 剥掉「模块不在白名单、且绑定名在代码里根本没被用到」的 import / require 语句。
 * LLM 顺手写 `import { Icon } from "lucide-react"` 这类 import 时，以前整颗节点直接
 * custom_tsx_bad_import 失败；而那条 import 通常压根没用到 —— 删掉即可正常渲染。
 * 反过来，**真的在用**的非法 import 不剥（剥了只会变成更难定位的「未定义标识符」），
 * 由调用方继续按 custom_tsx_bad_import 硬失败并给指引。
 * 返回 { source, removed }：removed 是被剥掉的模块名（调试 / 冒烟用）。
 */
function stripUnusedBadImports(src) {
  let out = String(src || "");
  const removed = [];
  const drop = (whole, prefix, body, spec) => {
    if (customImportAllowed(spec)) return whole;
    const rest = out.replace(whole, "");
    const names = importBindingNames(body);
    /* 副作用 import（import "m";）没有绑定名：没被任何地方引用，直接算未使用 */
    if (names.length && anyBindingUsed(rest, names)) return whole;
    if (removed.indexOf(spec) < 0) removed.push(spec);
    return prefix || "";
  };
  /* 静态 import：`import ... from "m"`（跨行也认，[^;] 保证不越过语句边界） */
  out = out.replace(
    /(^|\n)([ \t]*import\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"]\s*;?)(?=[ \t]*(?:\r?\n|$))/g,
    (whole, nl, stmt, spec) => drop(whole, nl, stmt, spec),
  );
  /* 副作用 import：`import "m";` */
  out = out.replace(
    /(^|\n)([ \t]*import\s*['"]([^'"]+)['"]\s*;?)(?=[ \t]*(?:\r?\n|$))/g,
    (whole, nl, stmt, spec) => drop(whole, nl, stmt, spec),
  );
  /* const X = require("m") / const { a } = require("m") / const X = import("m") */
  out = out.replace(
    /(^|\n)([ \t]*(?:const|let|var)\s+([^=;\n]+?)=\s*(?:await\s+)?(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)\s*;?)(?=[ \t]*(?:\r?\n|$))/g,
    (whole, nl, stmt, lhs, spec) => {
      if (customImportAllowed(spec)) return whole;
      const rest = out.replace(whole, "");
      const names = requireBindingNames(lhs);
      if (names.length && anyBindingUsed(rest, names)) return whole;
      if (removed.indexOf(spec) < 0) removed.push(spec);
      return nl || "";
    },
  );
  return { source: out, removed };
}

/**
 * 规整渲染层下发的 LLM 动效代码（params.tsx / params.prompt）：
 * 返回 { source, error }；source 为空串且 error 为空 = 没有自定义合成，调用方回退内置模板。
 * 契约（见渲染层 remotionTsxPrompt）：导出名为 Main 的组件，且只从 react / remotion 导入。
 * 容错：剥 markdown 围栏；没被用到的非白名单 import 整条剥掉（见 stripUnusedBadImports）；
 *       default 导出或唯一大写具名导出自动补 Main 别名。
 * 硬失败（比渲染栈更好定位，直接回到节点 error）：
 *   custom_tsx_bad_import: <模块列表> / custom_tsx_no_main_export
 */
function normalizeCustomComposition(raw) {
  let src = String(raw || "").trim();
  if (!src) return { source: "", error: "" };
  const fence = src.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/);
  if (fence) src = String(fence[1]).trim();
  if (!src) return { source: "", error: "" };

  /* 依赖白名单：静态 import / require() / 动态 import() 全扫（相对路径放行）。
     未使用的非法 import 自动剥掉（见 stripUnusedBadImports）；仍在用的才硬失败。 */
  const stripped = stripUnusedBadImports(src);
  src = stripped.source;
  const specs = collectImportSpecs(src);
  const bad = specs.filter((s) => !customImportAllowed(s));
  if (bad.length)
    return {
      source: "",
      error:
        "custom_tsx_bad_import: " +
        bad.join(", ") +
        "（这些包不在白名单：动效代码只能从 react / remotion 导入。请在代码里删掉对它们的引用、" +
        "改用 react / remotion 自带的实现；如果只是顺手写的图标 / 工具库 import，删掉那一行即可）",
    };

  /* 组件注册：入口固定以 id "Main" 引用 ./Composition 的 Main */
  if (/export\s+(?:const|let|var|function|class)\s+Main\b/.test(src)) {
    return { source: src + "\n", error: "" };
  }
  let alias = "";
  const defFn = src.match(/export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  const defCls = src.match(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
  const defId = src.match(/export\s+default\s+([A-Za-z_$][\w$]*)[ \t]*;?[ \t]*(?:\r?\n|$)/);
  if (defCls) alias = defCls[1];
  else if (defFn) alias = defFn[1];
  else if (defId && declaredHere(src, defId[1])) alias = defId[1];
  if (!alias) {
    /* 无 default：唯一的大写具名导出视为组件 */
    const named = [];
    const reNamed = /export\s+(?:const|let|var|function|class)\s+([A-Z][\w$]*)/g;
    let m;
    while ((m = reNamed.exec(src))) if (named.indexOf(m[1]) < 0) named.push(m[1]);
    if (named.length === 1) alias = named[0];
  }
  if (!alias) return { source: "", error: "custom_tsx_no_main_export" };
  /* 不带类型标注：别名行不依赖 React 是否被 import */
  return { source: src + "\n\nexport const Main = " + alias + ";\n", error: "" };
}

/**
 * 入口模板：注册唯一合成（id "Main"）。
 * 只 import { Main }（不 import CFG）——自定义合成不导出 CFG；
 * 这里的时长/尺寸只是占位，render.json 的同名字段会在 selectComposition 后就地覆盖。
 */
function buildIndexSource(params) {
  params = params || {};
  const width = Number(params.width) || 1280;
  const height = Number(params.height) || 720;
  const fps = Number(params.fps) || 30;
  const duration = Math.max(1, Math.round(Number(params.durationSeconds) || 5));
  const durationInFrames = Math.max(1, duration * fps);
  return `import React from "react";
import { registerRoot, Composition } from "remotion";
import { Main } from "./Composition";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Main"
      component={Main}
      durationInFrames={${durationInFrames}}
      fps={${fps}}
      width={${width}}
      height={${height}}
    />
  );
};

registerRoot(RemotionRoot);
`;
}

/** 解析媒体时长（语音决定成片总长）：优先 ffprobe；没有就用 Remotion 自带的
 *  @remotion/media-utils getAudioDuration（在渲染子进程里与 Chrome 无关），
 *  都拿不到返回 0（调用方回退调用方给的时长）。 */
function probeMediaDuration(file) {
  const p = String(file || "").trim();
  if (!p || !fs.existsSync(p)) return Promise.resolve(0);
  const secs = (s) => {
    const m = String(s || "").match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(Number(v) || 0);
      }
    };
    try {
      const ch = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", p], {
        windowsHide: true,
      });
      let out = "";
      ch.stdout.on("data", (d) => (out += d.toString()));
      ch.on("error", () => finish(0));
      ch.on("close", () => finish(Number(String(out).trim()) || 0));
      setTimeout(() => finish(0), 15000);
    } catch {
      finish(0);
    }
  });
}

/** 用 Remotion 的 getAudioDuration 兜底（ffprobe 缺失时）：在安装目录里跑一段 node -e */
function probeDurationViaRemotion(installDir, file) {
  const p = String(file || "").trim();
  if (!p || !fs.existsSync(p)) return Promise.resolve(0);
  const code =
    'const {getAudioDuration}=require("@remotion/media-utils");getAudioDuration(process.argv[1]).then(d=>{console.log(d);process.exit(0)}).catch(()=>process.exit(1));';
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(Number(v) || 0);
      }
    };
    try {
      const ch = spawn("node", ["-e", code, p], { cwd: installDir || process.cwd(), windowsHide: true });
      let out = "";
      ch.stdout.on("data", (d) => (out += d.toString()));
      ch.on("error", () => finish(0));
      ch.on("close", () => finish(Number(String(out).trim()) || 0));
      setTimeout(() => finish(0), 30000);
    } catch {
      finish(0);
    }
  });
}

/**
 * 写 src/Composition.tsx + src/index.tsx 模板（每次渲染前重写，参数即最新）。
 * Composition 优先采用渲染层下发的 LLM 动效代码（params.tsx / params.prompt），
 * 只有它为空时才回退内置标题卡模板（结构化参数 title / subtitle / bgColor / images / audioPath）。
 * 入口后缀必须是 .tsx：模板含 JSX（<Composition>），esbuild 只在 .tsx/.jsx 中解析 JSX，
 * 写成 .ts 会在打包阶段报 `Expected ">" but found "id"`。
 *
 * 落点纪律（踩过的现场）：源码必须写进 runRender 交给 render.json 的**同一个** projectDir ——
 * 第一个形参是 installDir（remotionProjectDirOf 需要它做兜底），工程目录由函数自己解析。
 * 早先这里直接用第一个形参当 projectDir，结果模板写进安装目录 <安装>/src，
 * 而 render.json.entryPoint 指向 <工作目录>/.mtnode/remotion/<节点>/src/index.tsx，
 * 打包阶段报 ENOENT ... src/index.tsx（看着像「文件丢了」，其实是写错地方）。
 * @returns {{ custom: boolean, builtin: boolean, projectDir: string, entryPoint: string, error: string }}
 *   error 非空 = 自定义合成不合规（不静默回退，直接失败）；projectDir / entryPoint = 实际落点
 */
function writeRenderSources(installDir, params) {
  const projectDir = remotionProjectDirOf(installDir, params);
  const srcDir = mk(join(projectDir, "src"));
  /* ── ① 固化工程（多文件）：整棵树写进 src/，入口固定 Composition.tsx ──
     这是「运行时完全脚本化」的落点：只要节点带 files，本函数一个模型都不碰，
     逐文件校验通过就照写；不合规直接失败（错误里点名文件，回灌给构建 agent 修）。 */
  const hasTree = params && params.files && typeof params.files === "object" && Object.keys(params.files).length;
  if (hasTree) {
    const check = validateProjectTree(params.files, "Composition.tsx");
    if (!check.ok) {
      return { custom: true, builtin: false, projectDir, entryPoint: "", error: check.errors.join("\n") };
    }
    const keep = new Set(Object.keys(check.files));
    for (const rel of Object.keys(check.files)) {
      const abs = join(srcDir, rel);
      mk(path.dirname(abs));
      fs.writeFileSync(abs, check.files[rel], "utf8");
    }
    /* 清掉上一版遗留、这一版已经不存在的源码（否则旧组件 / 旧相对导入会混进打包） */
    const staleClean = (dir, relDir) => {
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        const rel = relDir ? relDir + "/" + ent.name : ent.name;
        if (ent.isDirectory()) {
          if (ent.name === "node_modules") continue;
          staleClean(join(dir, ent.name), rel);
          continue;
        }
        if (rel === ENTRY_BASENAME) continue; /* 入口由下面重写 */
        if (!PROJECT_FILE_EXT.test(ent.name)) continue;
        if (keep.has(rel)) continue;
        try {
          fs.rmSync(join(dir, ent.name), { force: true });
          appendConsole("[render] 清理旧工程文件：" + rel);
        } catch {}
      }
    };
    staleClean(srcDir, "");
    fs.writeFileSync(join(srcDir, ENTRY_BASENAME), buildIndexSource(params), "utf8");
    try {
      fs.rmSync(join(srcDir, "index.ts"), { force: true });
    } catch {}
    appendConsole(
      "[render] frozen project written → " +
        srcDir +
        " (" +
        Object.keys(check.files).length +
        " files, contract=" +
        check.contract.length +
        ")",
    );
    return {
      custom: true,
      builtin: false,
      projectDir,
      entryPoint: join(srcDir, ENTRY_BASENAME),
      files: check.files,
      contract: check.contract,
      error: "",
    };
  }
  /* 专属「台词卡」内置模板已移除：这里不再按描述关键词 / 媒体输入抢道。
     合成源只有两种：显式 tsx（节点里贴的 / 工作流产物）→ 自定义合成；否则内置标题卡模板。 */
  const explicitTsx = String(params.tsx || "").trim();
  const builtinSrc = "";
  let custom = { source: "", error: "" };
  if (process.env.MTNODE_TEMPLATE_TRACE) appendConsole("[trace] writeRenderSources tsxLen=" + String(params.tsx || "").length + " inputs=" + ((params.inputs || []).length));
  if (!builtinSrc) {
    custom = normalizeCustomComposition(
      String(params.tsx || "").trim() || String(params.prompt || "").trim(),
    );
    if (custom.error) return { custom: false, error: custom.error };
  }
  const usingBuiltin = !!builtinSrc;
  const usingCustom = !usingBuiltin && !!custom.source;
  fs.writeFileSync(
    join(srcDir, "Composition.tsx"),
    usingBuiltin ? builtinSrc : usingCustom ? custom.source : buildCompositionSource(params),
    "utf8",
  );
  fs.writeFileSync(join(srcDir, ENTRY_BASENAME), buildIndexSource(params, { custom: usingCustom }), "utf8");
  /* 清理历史版本写错后缀的入口，避免旧 render.json 继续引用它 */
  try {
    fs.rmSync(join(srcDir, "index.ts"), { force: true });
  } catch {}
  appendConsole(
    "[render] templates written → " +
      srcDir +
      (usingBuiltin
        ? " (composition=builtin dialogue template)"
        : usingCustom
          ? " (composition=custom tsx " + custom.source.length + " chars)"
          : " (composition=builtin template)"),
  );
  return {
    custom: usingCustom,
    builtin: usingBuiltin,
    projectDir,
    entryPoint: join(srcDir, ENTRY_BASENAME),
    error: "",
  };
}

/** 输出路径：显式 outputPath > outputDir+filename（自动去重）> 安装目录 out/ 默认名 */
function resolveOutputPath(installDir, params) {
  const ext = ".mp4";
  if (String(params.outputPath || "").trim()) {
    return path.resolve(String(params.outputPath).trim());
  }
  const dir = String(params.outputDir || "").trim()
    ? path.resolve(String(params.outputDir).trim())
    : join(remotionProjectDirOf(installDir, params), "out");
  const preferred = String(params.filename || "").trim() || "render" + ext;
  return uniqueFileInDir(dir, preferred, ext).path;
}

/**
 * 渲染工程目录（用户代码与产物的唯一落点）：**永不落在插件安装目录 / 应用目录里**。
 *
 * 理由（与插件安装目录的本质冲突）：安装目录是「装插件时就有、升级会被覆盖」的现场，
 * 往里写用户代码 / 工程 / 成片，既会被升级冲掉，也让「重装即干净」失去意义。
 *
 * 解析顺序：
 *   ① params.workspace（渲染层下发的画布工作目录）→ <工作目录>/.mtnode/remotion/<节点 id>/
 *   ② 数据目录兜底 → %APPDATA%/pipeline-console/remotion-projects/<节点 id>/
 * 两档都是「用户自己的目录」，没有一个指向安装目录。
 */
function remotionProjectDirOf(installDir, params) {
  const p = params || {};
  const nodeId = String(p.nodeId || "default").replace(/[^\w.-]/g, "") || "default";
  const ws = String(p.workspace || "").trim();
  if (ws) return join(path.resolve(ws), ".mtnode", "remotion", nodeId);
  let base = "";
  try {
    base = app.getPath("userData");
  } catch {
    base = "";
  }
  if (!base) base = process.env.MTNODE_DATA_DIR || join(require("os").tmpdir(), "mtnode-remotion");
  return join(base, "remotion-projects", nodeId);
}

/**
 * 解析 render.mjs 的进度输出（JSON Lines 契约，见 remotion-pack/render.mjs）：
 *   {"type":"progress","progress":0.42}     渲染进度 0..1（0.5% 步进节流）
 *   {"type":"done","outputLocation":"..."}  完成，输出绝对路径
 *   {"type":"error","message":"..."}        失败原因（脚本以退出码 1 结束）
 * 另保留 remotion 标准 "Rendered x/y (z%)" 进度行兜底。
 */
function parseRenderProgressLine(line, cur) {
  const s = String(line || "").trim();
  if (s.startsWith("{")) {
    let obj = null;
    try {
      obj = JSON.parse(s);
    } catch {}
    if (obj && typeof obj === "object") {
      if (obj.type === "progress" && typeof obj.progress === "number") {
        cur.pct = Number(obj.progress) * 100;
      } else if (obj.type === "done" && typeof obj.outputLocation === "string") {
        cur.outputPath = obj.outputLocation.trim();
      } else if (obj.type === "error" && typeof obj.message === "string") {
        cur.error = String(obj.message);
      }
    }
  }
  const m2 = s.match(/Rendered\s+(\d+)\s*\/\s*(\d+)\s*\(\s*([\d.]+)%\s*\)/);
  if (m2) cur.pct = Number(m2[3]);
  if (cur.pct != null && isFinite(cur.pct)) {
    cur.pct = Math.max(0, Math.min(100, Number(cur.pct)));
  }
}

/**
 * spawn `node render.mjs`（remotion-pack 内的渲染脚本，契约见 remotion-pack/render.mjs）：
 * - 渲染前按契约写 render.json（脚本只读它，不再使用环境变量）：
 *   entryPoint（宿主生成的 src/index.tsx 入口）/ composition / fps / width / height /
 *   durationInFrames / inputProps{title,subtitle,bgColor,audioPath?} / codec:h264 /
 *   outputLocation=resolveOutputPath 结果（绝对路径）
 * - stdout 逐行 JSON Lines：{"type":"progress","progress":0..1}（渲染进度）、
 *   {"type":"done","outputLocation":"..."}（完成路径）、{"type":"error","message":"..."}（失败）
 * - 退出码 0 = 成功；非 0 = 失败（优先带脚本 error message，尾部日志兜底）
 */
async function runRender(installDir, params, nodeId, written) {
  const script = join(installDir, "render.mjs");
  if (!fs.existsSync(script)) {
    throw new Error("render_script_missing: " + script + "（remotion-pack 缺少 render.mjs）");
  }
  /* 工程目录 = 用户代码 / render.json / 成片的落点：画布工作目录（见 remotionProjectDirOf），
     插件安装目录只当依赖源与渲染脚本来源（那条路升级会覆盖，用户数据一律不许进去）。 */
  const projectDir = remotionProjectDirOf(installDir, params);
  mk(projectDir);
  const outPath = resolveOutputPath(installDir, params);
  /* ── 端子契约（固化工程）：props / 媒体落地在这一步先算完 ──────────────
     写成「先算后渲染」是为了音频时长覆盖时长：接了音频端子且能探到实际时长时，
     成片总长 = 音频时长（共识），否则用节点设置里的时长。 */
  const projectContract =
    (written && Array.isArray(written.contract) && written.contract.length
      ? written.contract
      : normalizeContract(params.contract)) || [];
  const contractBuilt = projectContract.length ? contractPropsOf(params, projectContract) : null;
  let audioDuration = 0;
  if (contractBuilt && contractBuilt.audioFiles.length) {
    for (const f of contractBuilt.audioFiles) {
      let d = 0;
      try {
        d = await probeMediaDuration(f);
      } catch {}
      if (!d) {
        try {
          d = await probeDurationViaRemotion(installDir, f);
        } catch {}
      }
      if (d > 0) {
        audioDuration = d;
        appendConsole("[render] audio terminal duration = " + d.toFixed(2) + "s (" + path.basename(f) + ")");
        break;
      }
    }
  }
  /* 渲染要用的浏览器：先从国内镜像预置（Remotion 自己的下载直链硬编码在 Google 存储上，
     国内常常不通），失败回退本机 Edge / Chrome 并把路径交给 render.mjs。 */
  const browserInfo = await ensureRenderBrowser(installDir);
  if (!browserInfo.ok) {
    appendConsole("[render] browser missing: " + (browserInfo.hint || ""));
    reportErr("browser_missing", browserInfo.hint || "渲染浏览器缺失", renderReportCtx(params, nodeId));
    throw new Error(browserInfo.hint || "browser_missing");
  }
  return new Promise((resolve, reject) => {
    /* ---- 按 remotion-pack/render.mjs 契约写 render.json（render.mjs 默认读 ./render.json） ---- */
    const fps = Number(params.fps) || 30;
    const duration = Math.max(
      1,
      Math.round(audioDuration > 0 ? audioDuration : Number(params.durationSeconds) || 5),
    );
    if (audioDuration > 0 && Math.abs(Math.round(audioDuration * fps) - Math.round((Number(params.durationSeconds) || 5) * fps)) > 1) {
      emitProgress({
        phase: "render",
        nodeId,
        message: "音频时长覆盖成片时长：" + duration + "s",
        pct: 3,
      });
    }
    const renderJson = {
      /* 工程目录：脚本据此解析相对资源、写日志缓存（缺省会退回安装目录，必须显式给） */
      projectDir,
      /* 入口取模板**实际写出**的那个文件（writeRenderSources 回传），不再靠 join 猜同一个目录：
         猜错一回就是 ENOENT ... src/index.tsx（模板写进安装目录、入口指向工程目录那个老现场） */
      entryPoint:
        (written && written.entryPoint) || join(projectDir, ENTRY_POINT) /* 兜底：工程目录的 src/index.tsx */,
      composition: String(params.compositionId || "Main"),
      fps,
      width: Number(params.width) || 1280,
      height: Number(params.height) || 720,
      durationInFrames: Math.max(1, Math.round(duration * fps)),
      inputProps: {
        title: String(params.title || ""),
        subtitle: String(params.subtitle || ""),
        bgColor: String(params.backgroundColor || "#0f1218"),
      },
      nodeModulesDir: join(installDir, "node_modules") /* 依赖源：react / remotion 只在安装目录里 */,
      codec: "h264",
      outputLocation: outPath,
      /* 只在回退本机浏览器时才有值（国内镜像预置成功时留空 = 用 Remotion 钉版的那份） */
      ...(browserInfo.browserExecutable ? { browserExecutable: browserInfo.browserExecutable } : {}),
    };
    if (String(params.audioPath || "").trim()) {
      renderJson.inputProps.audioPath = String(params.audioPath).trim();
    }
    /* ── 自定义合成参数（通用通道，见 customPropsOf / propsFromInputs）──
       专属「台词卡」模板已移除：接线文本里声明的 props、节点参数里的未知键、参数文件，
       全部只经这一条通道交给合成代码，不会被任何内置模板抢先注入或改写。 */
    if (renderModeOf(params) === "custom") {
      const nodeProps = customPropsOf(params);
      if (contractBuilt) {
        /* 固化工程：契约是唯一 props 通道；节点参数里的显式同名键仍可覆盖（老口径） */
        Object.assign(renderJson.inputProps, contractBuilt.props);
        Object.assign(renderJson.inputProps, nodeProps.props);
        const keys = Object.keys(contractBuilt.props);
        appendConsole(
          "[render] contract props: " +
            (keys.length
              ? keys
                  .map(
                    (k) =>
                      k +
                      "(" +
                      (Array.isArray(renderJson.inputProps[k]) ? "array" : typeof renderJson.inputProps[k]) +
                      ")",
                  )
                  .join(", ")
              : "-"),
        );
        /* 没接线的必填端子：日志点名（合成层要自己兜住，构建提示词里已写明） */
        for (const c of projectContract) {
          if (c.required && contractBuilt.props[c.key] == null)
            appendConsole("[render] 必填端子未接线：" + c.key + "（" + c.label + "）");
        }
        for (const w of contractBuilt.warnings) appendConsole("[render] 契约输入：" + w);
      } else {
        const fromInputs = propsFromInputs(params.inputs, []);
        const merged = Object.assign({}, fromInputs, nodeProps.props);
        /* 接线里的媒体（视频 / 音频 / 图片）内联成 data URL 一并交出：渲染页禁止 file://，
           显式给了同名键的不覆盖（见 inlineMediaPropsOf 注释）。 */
        Object.assign(merged, inlineMediaPropsOf(params.inputs, merged));
        /* 纯文本台词：上面两条通道都不认的文本，作为 narration 交出（见 narrationFromInputs） */
        const narration = narrationFromInputs(params.inputs, merged);
        if (narration && !String(merged.narration || "").trim()) merged.narration = narration;
        /* ── 节拍表 → lineStarts ──────────────────────────────────────
           画布上「台词节拍 · 换页节奏」接的是**纯文本表格**（序号 | 台词 | 起(s) | 止(s) | 时长），
           propsFromInputs 不认它；而合成层只读 props.lineStarts 数组 —— 于是节拍从来没进过渲染，
           换页只能按均分时间走（实测）。
           beatStartsFromInputs 早就写好了却一直没人调用（死函数），这里把它接上：
           显式给了 lineStarts 的不覆盖；表格解析不出（>=2 句）就什么都不做，退回均分。 */
        if (!Array.isArray(merged.lineStarts) || !merged.lineStarts.length) {
          const beats = beatStartsFromInputs(
            (Array.isArray(params.inputs) ? params.inputs : []).map((it) => String((it && it.text) || "")),
            renderJson.fps,
          );
          if (beats.length) {
            merged.lineStarts = beats;
            appendConsole("[render] lineStarts from beat table: [" + beats.join(",") + "]");
          }
        }
        Object.assign(renderJson.inputProps, merged);
        for (const w of nodeProps.warnings) appendConsole("[render] 自定义合成参数：" + w);
        const keys = Object.keys(merged);
        appendConsole(
          "[render] custom props: " +
            (keys.length ? keys.map((k) => k + "(" + (Array.isArray(merged[k]) ? "array" : typeof merged[k]) + ")").join(", ") : "-") +
            (nodeProps.warnings.length ? " warnings=" + nodeProps.warnings.length : ""),
        );
      }
    }
    /* ── 音视频走独立通道（mediaBlobs）──────────────────────────────
       <OffthreadVideo> 会把 src 拼进 `/proxy?src=<整个 src>`：data URL 一大就 431。
       所以视频 / 音频不放进 render.json 的 inputProps，而是单独给 mediaBlobs，
       由 render.mjs 落成 <工程>/public/<文件名>，渲染页只拿短文件名。
       图片（<Img> 不走 proxy）保持 data URL 原样。
       固化工程这一路：文件名与 props 值都由 contractPropsOf 定好（数组项按接线顺序），
       render.mjs 只照 meta 写盘、把 name 放回 props。 */
    if (contractBuilt && Object.keys(contractBuilt.mediaBlobs).length) {
      renderJson.mediaBlobs = contractBuilt.mediaBlobs;
      renderJson.mediaBlobsMeta = contractBuilt.mediaBlobsMeta;
      appendConsole("[render] media parked (contract): " + Object.keys(contractBuilt.mediaBlobs).join(", "));
    } else if (renderModeOf(params) === "custom") {
      const mediaBlobs = {};
      const mediaBlobsMeta = {};
      for (const prop of ["hero", "voice"]) {
        const v = renderJson.inputProps[prop];
        if (typeof v !== "string" || !/^data:/i.test(v.trim())) continue;
        const comma = v.indexOf(",");
        if (comma < 0) continue;
        mediaBlobs[prop] = v.slice(comma + 1);
        const mime = v.slice(5, comma).replace(/;base64$/i, "");
        mediaBlobsMeta[prop] = { mime };
        delete renderJson.inputProps[prop];
      }
      const blobProps = Object.keys(mediaBlobs);
      if (blobProps.length) {
        renderJson.mediaBlobs = mediaBlobs;
        renderJson.mediaBlobsMeta = mediaBlobsMeta;
        appendConsole("[render] media parked: " + blobProps.join(", "));
      }
    }
    const renderJsonPath = join(projectDir, "render.json");
    writeJson(renderJsonPath, renderJson);
    appendConsole(
      "[render] render.json written (composition=" +
        renderJson.composition +
        " entry=" +
        renderJson.entryPoint +
        " output=" +
        outPath +
        ")",
    );
    const child = spawn("node", [script, renderJsonPath], {
      /* cwd 用工程目录：子进程即便有相对路径（脚本自己写的日志 / 缓存）也落不到安装目录里 */
      cwd: projectDir,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        NODE_PATH: join(installDir, "node_modules"),
        MTNODE_REMOTION_INSTALL_DIR: installDir,
        MTNODE_REMOTION_PROJECT_DIR: projectDir,
      }),
    });
    renderProc = { nodeId, child, abort: false, pct: 0, outputPath: "" };
    const cur = { pct: 0, outputPath: "", error: "" };
    let out = "";
    const deadline = Date.now() + RENDER_MAX_MS;

    const onData = (d, isErr) => {
      const s = d.toString();
      out += s;
      for (const rawLine of s.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        appendConsole((isErr ? "[err] " : "") + line);
        parseRenderProgressLine(line, cur);
        if (cur.pct != null && isFinite(cur.pct)) {
          renderProc.pct = cur.pct;
          emitProgress({
            phase: "render",
            nodeId,
            message: "渲染 " + Math.round(cur.pct) + "%",
            pct: Math.max(1, Math.min(95, Math.round(cur.pct * 0.95))),
          });
        }
        if (cur.outputPath) renderProc.outputPath = cur.outputPath;
      }
    };
    child.stdout.on("data", (d) => onData(d, false));
    child.stderr.on("data", (d) => onData(d, true));
    child.on("error", (e) => {
      renderProc = null;
      reject(new Error("render_spawn: " + String((e && e.message) || e)));
    });
    child.on("close", (code) => {
      const proc = renderProc;
      renderProc = null;
      if (proc && proc.abort) return reject(new Error("cancelled"));
      if (code !== 0) {
        return reject(
          new Error("render_exit_" + code + (cur.error ? ": " + cur.error : ": " + out.slice(-1200))),
        );
      }
      const realOut = cur.outputPath || outPath;
      if (!fs.existsSync(realOut)) {
        return reject(new Error("output_missing: " + realOut));
      }
      resolve({ outputPath: realOut });
    });
    /* 超时保护：超时未退出则杀子进程 */
    const timer = setTimeout(() => {
      appendConsole("[render] timeout after " + RENDER_MAX_MS + "ms — killing");
      try {
        if (renderProc && renderProc.child) renderProc.child.kill();
      } catch {}
    }, RENDER_MAX_MS);
    if (timer.unref) timer.unref();
  });
}

function killPidTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      resolve();
    }
  });
}

/**
 * 渲染任务：渲染前取 media-gen-global-lock 全局互斥（与 H3 / Music3 全局唯一音视频任务）。
 * 完成返回 { ok, path, bytes, message }。
 */
async function renderVideo(params) {
  params = params || {};
  const nodeId = String(params.nodeId || "");
  if (!nodeId) {
    /* 没有节点 id 也要出声：该码在总线里判成不可自动修，报告只指路，否则节点就是静默失败 */
    reportErr("missing_node_id", "Remotion 渲染请求缺少节点 id（画布数据异常）", renderReportCtx(params, ""));
    return { ok: false, error: "missing_node_id" };
  }

  const cfg = loadConfig();
  const installDir = String(cfg.installDir || "").trim();
  if (!installDir || !fs.existsSync(installDir)) {
    reportErr("not_installed", "Remotion 后端尚未安装（安装目录不存在）", renderReportCtx(params, nodeId));
    return { ok: false, error: "not_installed" };
  }
  if (!runtimeReadyAt(installDir)) {
    reportErr("not_ready", "Remotion 依赖未就绪：node_modules/remotion 缺失，请在插件卡片点「下载安装」重跑 npm install", renderReportCtx(params, nodeId));
    return { ok: false, error: "not_ready" };
  }

  const acq = tryAcquireLock({ nodeId, workflowId: params.workflowId || "", kind: "video_gen" });
  if (!acq.ok) {
    const lock = acq.lock;
    const msg = busyMessage(lock) || "全局音视频锁被另一个节点占着（同一时刻只允许 1 个音乐 / 视频任务）";
    appendConsole("[job] busy_other_node: " + (lock && lock.nodeId ? lock.nodeId : ""));
    /* 锁被占也算失败出口：不报的话节点只是灰在那里，用户不知道该等谁 */
    reportErr("busy_other_node", msg, renderReportCtx(params, nodeId));
    return { ok: false, error: "busy_other_node", lock, message: msg };
  }

  let written = null;
  try {
    appendConsole("[job] render start node=" + nodeId);
    emitProgress({ phase: "render", nodeId, message: "准备渲染源文件…", pct: 2 });
    written = writeRenderSources(installDir, params);
    if (written.error) throw new Error(written.error);

    emitProgress({ phase: "render", nodeId, message: "spawn node render.mjs…", pct: 4 });
    const r = await runRender(installDir, params, nodeId, written);

    const outPath = r.outputPath;
    let sz = 0;
    try {
      sz = fs.statSync(outPath).size || 0;
    } catch {}
    if (sz < 64) throw new Error("output_file_empty_or_too_small: " + outPath);

    clearLock();
    emitProgress({ phase: "render", nodeId, message: "完成", pct: 100, done: true });
    appendConsole("[job] ok path=" + outPath + " bytes=" + sz);
    return { ok: true, path: outPath, outputPath: outPath, bytes: sz, message: "Saved: " + outPath };
  } catch (e) {
    const raw = String((e && e.message) || e);
    /* 渲染子进程的原始错误（如 interpolate inputRange 校验失败）翻译成可定位的中文指引 */
    const err = friendlyRenderError(raw, !!(written && written.custom));
    appendConsole("[job] error: " + err);
    clearLock();
    emitProgress({ phase: "render", nodeId, message: err, error: true, pct: 0 });
    reportErr(err, err, renderReportCtx(params, nodeId));
    return { ok: false, error: err, message: err };
  }
}

/* ── 短试渲染（构建验证 / 设置窗「试渲染」）─────────────────────────────
   与 renderVideo 的区别（全部是刻意的）：
     · **不取**全局音视频互斥锁 —— 它只烧几秒 CPU、不出交付物，不该把用户的音乐 / 视频任务排队挡住（共识）；
     · 时长压到 ≤2 秒、产物写进 <工程>/verify/ 并在成功后删掉，不当成片留在节点输出里；
     · 没接线的媒体端子用内置占位素材兜住（占位图 / 1 秒静音），让「工程本身能不能渲染」可判。
   返回 { ok, error?, contract?, warnings? }。 */
function placeholderImageDataUrl() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">' +
    '<rect width="1280" height="720" fill="#1f2937"/>' +
    '<text x="640" y="380" font-size="48" fill="#9ca3af" text-anchor="middle" font-family="sans-serif">PLACEHOLDER</text>' +
    "</svg>";
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}
function silentWavDataUrl(seconds) {
  const rate = 8000;
  const bits = 16;
  const ch = 1;
  const n = Math.max(1, Math.round(rate * (Number(seconds) || 1)));
  const dataBytes = n * (bits / 8) * ch;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * (bits / 8), 28);
  buf.writeUInt16LE(ch * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return "data:audio/wav;base64," + buf.toString("base64");
}

/** 试渲染的输入：已接线的原样保留，没接线的媒体 / 文本端子补占位值 */
function verifyPlaceholderInputs(contract, inputs) {
  const list = Array.isArray(inputs) ? inputs.slice() : [];
  const given = new Set(list.map((x) => String((x && x.key) || "")).filter(Boolean));
  contract.forEach((c, i) => {
    if (given.has(c.key)) return;
    if (c.kind === "image") list.push({ key: c.key, index: i, text: placeholderImageDataUrl() });
    else if (c.kind === "audio") list.push({ key: c.key, index: i, text: silentWavDataUrl(1) });
    else if (c.kind === "text") list.push({ key: c.key, index: i, text: "示例文本 sample" });
  });
  return list;
}

async function verifyRender(params) {
  const p = params || {};
  const nodeId = String(p.nodeId || "verify");
  const cfg = loadConfig();
  const installDir = String(cfg.installDir || "").trim();
  if (!installDir || !fs.existsSync(installDir)) {
    return { ok: false, error: "not_installed", message: "Remotion 后端尚未安装（安装目录不存在）" };
  }
  if (!runtimeReadyAt(installDir)) {
    return {
      ok: false,
      error: "not_ready",
      message: "Remotion 依赖未就绪：node_modules/remotion 缺失，请先在插件卡片点「下载安装」",
    };
  }
  const check = validateProjectTree(p.files, "Composition.tsx");
  if (!check.ok) {
    return { ok: false, error: "project_invalid", message: check.errors.join("\n"), errors: check.errors };
  }
  const projectDir = remotionProjectDirOf(installDir, p);
  const verifyParams = Object.assign({}, p, {
    files: check.files,
    contract: check.contract,
    inputs: verifyPlaceholderInputs(check.contract, p.inputs),
    durationSeconds: Math.max(1, Math.min(2, Number(p.durationSeconds) || 2)),
    outputPath: join(projectDir, "verify", "verify-" + Date.now() + ".mp4"),
  });
  try {
    const written = writeRenderSources(installDir, verifyParams);
    if (written.error) return { ok: false, error: "project_invalid", message: written.error };
    appendConsole("[verify] start node=" + nodeId + " duration=" + verifyParams.durationSeconds + "s");
    const r = await runRender(installDir, verifyParams, nodeId, written);
    try {
      fs.rmSync(r.outputPath, { force: true });
    } catch {}
    appendConsole("[verify] ok node=" + nodeId);
    return {
      ok: true,
      contract: check.contract,
      warnings: check.warnings,
      files: Object.keys(check.files),
      message: "试渲染通过（" + verifyParams.durationSeconds + "s）",
    };
  } catch (e) {
    const raw = String((e && e.message) || e);
    const err = friendlyRenderError(raw, true);
    appendConsole("[verify] error: " + err);
    return { ok: false, error: "render_failed", message: err, raw };
  }
}

function cancelRender(nodeId) {
  const nid = String(nodeId || "");
  let hitNodeId = "";
  if (renderProc && renderProc.child && (!nid || renderProc.nodeId === nid)) {
    hitNodeId = renderProc.nodeId || "";
    renderProc.abort = true;
    const pid = renderProc.child.pid;
    appendConsole("[cancel] render cancelled node=" + (hitNodeId || "?") + " pid=" + pid);
    try {
      renderProc.child.kill();
    } catch {}
    killPidTree(pid);
    renderProc = null;
  }
  releaseLock(nid || undefined);
  emitProgress({
    phase: "render",
    nodeId: nid || hitNodeId,
    message: "已取消渲染",
    error: true,
    cancelled: true,
  });
  reportErr("cancelled", "渲染已取消（用户主动停止）", { phase: "render", nodeId: nid || hitNodeId });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 插件安装后自检（动效视频类）                                          */
/* ------------------------------------------------------------------ */

/**
 * 「插件安装后自检」在动效视频这一类的实现（内核见 plugins/plugin-selfcheck.js 头部契约）。
 * 链路：现成的 environmentCheck → 运行时是否就位 → 等全局媒体锁空闲 → 真渲染最低档一帧
 *       → 产物存在且字节 > 0。
 *
 * 为什么每一步都在那儿（各自拦一类真实故障，不是为了凑步骤）：
 *   · 环境项先摆出来：node / npm 缺失、目录不可写、随包脚手架或 scripts\install.ps1 漏打包，
 *     都是「根本装不上」的根因；这些不过就别再往下走，安装窗一眼看得见修法；
 *   · 运行时（node_modules/remotion）不就位时**绝不渲染**：现在渲染只会回 not_ready，
 *     那属于「还没装好 = 没得测」（内核的 skipped 语义），不是「这个插件坏了」（fail）；
 *   · 全局媒体锁：Remotion 出片与 H3 / Music3 抢同一个 media-gen-global-lock，不等锁直接渲染会被
 *     判 busy_other_node —— 那是机器正忙，不是插件有问题，所以交给内核排队等锁（上限 30 分钟）；
 *   · 真渲染 + 产物校验：自检的意义是「真出一次内容」，产物必须落在内核给的 ctx.artifactDir 且非空
 *     （数据纪律：绝不落应用目录，也不往安装目录里塞用户数据）。
 */
async function selfcheckMotion(ctx) {
  const c = ctx || {};
  /** 逐项明细：既累积进返回值（安装窗重画整份明细），又经 c.step 实时推给安装窗 */
  const steps = [];
  /** 取消标记（内核点「取消自检」时置真）；ctx 上可能没有，兜一个恒假的现场 */
  const sig = c.signal || { aborted: false };
  const aborted = () => !!sig.aborted;

  /**
   * 记一步：同 id 覆盖（占位行 → 结果行），避免「等锁 / 渲染」这类先 run 后出结论的步骤在明细里出现两行
   * ——安装窗也是按 title 就地替换的（见 install/app.js 的 ev.step 处理），两边口径一致。
   * status 只取安装窗认得的四个值：ok / fail / skip / run（✓ / ✕ / — / ·）。
   */
  const step = (id, title, status, detail) => {
    const s = {
      id: String(id || "step"),
      title: String(title || ""),
      status: String(status || "run"),
      detail: detail == null ? "" : String(detail),
    };
    const at = steps.findIndex((x) => x.id === s.id);
    if (at >= 0) steps[at] = s;
    else steps.push(s);
    try {
      if (typeof c.step === "function") c.step({ title: s.title, status: s.status, detail: s.detail });
    } catch {}
    return s;
  };
  const log = (line) => {
    try {
      if (typeof c.log === "function") c.log(line);
    } catch {}
  };

  if (aborted()) return { ok: false, skipped: true, reason: "已取消", steps };

  /* 自检产物必须落在内核给的目录里；取不到目录就不要渲染（否则只能落到安装目录，等于往用户数据里塞东西） */
  const artifactDir = String(c.artifactDir || "").trim();
  if (!artifactDir) {
    const msg = "自检产物目录不可用（数据目录取不到）：无法决定产物落哪，先不渲染";
    step("artifact_dir", "自检产物目录", "fail", msg);
    return { ok: false, error: msg, steps };
  }

  /* 渲染目录以「已经就绪的那一份」为准：renderVideo 只认 config.json 的 installDir，
     而 ctx.installDir 是安装窗按插件根推导出来的现场（同样合法）。两边不一致时优先信能真跑的那份，
     免得出现「自检说就绪、真渲染说不就绪」的假绿；渲染真报 not_installed 时按原文如实带回去。 */
  const ctxDir = String(c.installDir || "").trim();
  const installDir = runtimeReadyAt(ctxDir) ? ctxDir : String(loadConfig().installDir || "").trim();

  /* ---- ① 环境：复用现成的 environmentCheck（不另写一份环境检查） ---- */
  let rep = null;
  try {
    rep = await environmentCheck({ installDir });
  } catch (e) {
    const msg = "环境自检自身抛错：" + String((e && e.message) || e);
    step("env", "环境自检", "fail", msg);
    return { ok: false, error: msg, steps };
  }
  step(
    "env",
    "环境自检（node / npm / 安装目录 / 随包脚手架）",
    rep.ok ? "ok" : "fail",
    rep.ok ? "必需项全部通过" : "未过项：" + (rep.bad || []).join(" / "),
  );
  /* 逐项翻成明细行：必需项不通过 = fail（红，拦自检）；非必需项（磁盘余量、npm 源可达、运行时）不通过 = skip
     （灰 —— environmentCheck 本来就只提示不拦，这里也不该把自检判死）。detail 用该项自己的 detail。 */
  for (const it of rep.items || []) {
    step(
      "env:" + String(it.key || ""),
      String(it.label || it.key || "环境项"),
      it.ok ? "ok" : it.required ? "fail" : "skip",
      it.detail,
    );
  }
  if (!rep.ok) {
    /* 整份报告进日志区（含每个失败项的修法），便于用户直接交给会话修复 */
    for (const line of formatEnvironmentReport(rep)) {
      /* 报告行自带 "[selfcheck] " 前缀（它还要直接进 console.log）；安装窗日志区会再加一个同名前缀，
         这里剥掉，避免出现 "[selfcheck] [selfcheck] …" 的双前缀 */
      log(String(line).replace(/^\[selfcheck\]\s?/, ""));
    }
    return { ok: false, error: "环境自检未通过：" + (rep.bad || []).join(" / "), steps };
  }

  /* ---- ② 运行时是否就位：没装好就绝不渲染 ---- */
  const ready = runtimeReadyAt(installDir);
  step(
    "runtime",
    "运行时（node_modules/remotion）",
    ready ? "ok" : "skip",
    ready
      ? installDir + " · v" + (remotionVersionAt(installDir) || "?")
      : "未就位：" + (installDir || "（安装目录未设置）") + " —— 自检没得跑（先装好再自检）",
  );
  if (!ready) {
    /* 判 skipped 而不是 fail 的理由：「还没装好」= 缺工具，正是内核 skipped 的定义（不打勾、如实展示原因）；
       这一步也不该红色报警 —— 安装窗那边若安装真失败了，失败原因早已写在安装步骤里，不该由自检二手转述。
       注意：这里只是「不算自检通过」，**绝不能**在没装好时去渲染。 */
    log("还没装好（runtime not ready）：" + (installDir || "(安装目录未设置)"));
    return { ok: false, skipped: true, reason: "还没装好（runtime not ready）", steps };
  }

  /* ---- ③ 等全局媒体锁空闲（超时 / 取消都算跳过，不打勾） ---- */
  if (aborted()) return { ok: false, skipped: true, reason: "已取消", steps };
  step("lock", "等全局生成锁", "run", "与 H3 / Music3 同一个全局互斥锁，占用时自动排队（上限 30 分钟）…");
  let lk = null;
  try {
    lk = await c.waitMediaLock();
  } catch (e) {
    lk = { ok: false, reason: "error", message: String((e && e.message) || e) };
  }
  if (aborted() || (lk && lk.reason === "cancelled")) {
    step("lock", "等全局生成锁", "skip", "已取消");
    return { ok: false, skipped: true, reason: "已取消", steps };
  }
  if (!lk || !lk.ok) {
    const why = String((lk && (lk.message || lk.reason)) || "unknown");
    step("lock", "等全局生成锁", "skip", "等锁超时 / 失败：" + why);
    return { ok: false, skipped: true, reason: "等全局生成锁超时", steps };
  }
  step("lock", "等全局生成锁", "ok", "拿到锁（等待 " + String((lk && lk.waitedMs) || 0) + "ms）");

  /* ---- ④ 真渲染最低档：64x64 / 1fps / 1 秒 = 1 帧（模板已避开 durationInFrames<=1 的 interpolate 报错） ---- */
  if (aborted()) return { ok: false, skipped: true, reason: "已取消", steps };
  const nodeId = "selfcheck-remotion-" + Date.now();
  /* 取消要真收手：内核只置取消标记，渲染子进程得由宿主 kill（否则最长要干等 RENDER_MAX_MS = 30 分钟）。
     挂 onAbort 而不是轮询 —— cancelRender 会杀进程树并释放它自己占的那个锁；渲染已经结束就摘掉钩子。 */
  if (typeof sig === "object") {
    sig.onAbort = () => {
      try {
        cancelRender(nodeId);
      } catch {}
    };
  }
  step("render", "最低档渲染（64x64 / 1fps / 1 帧）", "run", "spawn node render.mjs …");
  let r = null;
  try {
    r = await renderVideo({
      /* nodeId 必给：renderVideo 没它就回 missing_node_id（进度 / 报错 / 取消都靠它定位） */
      nodeId,
      width: 64,
      height: 64,
      fps: 1,
      durationSeconds: 1,
      title: "selftest",
      /* 输出路径交给 host 侧解析：显式 outputPath > outputDir+filename（自动去重）> 安装目录 out/
         （见 resolveOutputPath）；这里只给 outputDir，文件名由它去重生成，重复自检不会互相覆盖 */
      outputDir: artifactDir,
    });
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  if (typeof sig === "object") sig.onAbort = null;
  if (aborted()) {
    step("render", "最低档渲染（64x64 / 1fps / 1 帧）", "skip", "已取消");
    return { ok: false, skipped: true, reason: "已取消", steps };
  }
  if (!r || !r.ok) {
    /* 失败一律带原文（friendlyRenderError 已把它翻成人话），不自己编根因 */
    const raw = String((r && (r.error || r.message)) || "unknown");
    step("render", "最低档渲染（64x64 / 1fps / 1 帧）", "fail", raw);
    return { ok: false, error: "自检渲染失败：" + raw, steps };
  }

  /* ---- ⑤ 产物校验：必须在、且字节 > 0（自检的产物是「真出过内容」的唯一凭据） ---- */
  const outPath = String(r.outputPath || r.path || "").trim();
  let bytes = 0;
  try {
    bytes = fs.statSync(outPath).size || 0;
  } catch {}
  if (!outPath || !fs.existsSync(outPath) || bytes <= 0) {
    const msg =
      "自检产物校验失败：" +
      (outPath || "(渲染回执里没有输出路径)") +
      "（存在=" +
      (outPath ? fs.existsSync(outPath) : false) +
      "，字节=" +
      bytes +
      "）";
    step("artifact", "产物校验（存在且字节 > 0）", "fail", msg);
    step("render", "最低档渲染（64x64 / 1fps / 1 帧）", "ok", "渲染完成，但产物不可用");
    return { ok: false, error: msg, steps };
  }
  step("render", "最低档渲染（64x64 / 1fps / 1 帧）", "ok", outPath + "（" + bytes + " 字节）");
  step("artifact", "产物校验（存在且字节 > 0）", "ok", outPath + "（" + bytes + " 字节）");

  /* 结果不自己写盘：内核统一落 <数据目录>/plugin-selfcheck/<id>.json，这里只把产物交出去 */
  return { ok: true, artifacts: [{ path: outPath, label: "自检渲染的动效视频" }], steps };
}

/* require 期登记（本模块被主进程 require 时即生效；内核据此知道 remotion 有生成类自检，
   主窗口插件卡片的勾角标与安装窗的「重新自检」都靠它）。登记只回 { ok }，不会抛，也不影响其它能力。 */
registerPluginSelfcheck({
  id: PLUGIN_ID,
  key: "remotion",
  label: "Remotion 动效视频",
  kind: "motion",
  check: selfcheckMotion,
});

/* ------------------------------------------------------------------ */
/* 控制台窗 / 卸载元数据                                                */
/* ------------------------------------------------------------------ */
function openConsoleWindow() {
  ensureUiRuntime();
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    notifyConsoleChanged(true);
    return { ok: true, open: true };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) return { ok: false, error: "ui_missing" };

  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 460,
    height: 600,
    x: Math.min(wa.x + wa.width - 480, wa.x + wa.width - 100),
    y: wa.y + 40,
    frame: true,
    show: true,
    title: "Remotion · 本地渲染",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-remotion.js"),
    },
  });
  consoleWin.loadFile(entry);
  consoleWin.on("closed", () => {
    consoleWin = null;
    notifyConsoleChanged(false);
  });
  notifyConsoleChanged(true);
  return { ok: true, open: true };
}

function closeConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  notifyConsoleChanged(false);
  return { ok: true, open: false };
}

function notifyConsoleChanged(open) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) {
      w.webContents.send("remotion:consoleChanged", { open: !!open });
    }
  } catch {}
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 Remotion 安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  const ready = runtimeReadyAt(safe.path);
  if (ready) {
    writeJson(installedMetaPath(), {
      ok: true,
      version: remotionVersionAt(safe.path) || "0.0.0",
      installDir: safe.path,
      discovered: true,
      installedAt: new Date().toISOString(),
    });
  }
  return { ok: true, installDir: safe.path, runtimeReady: ready };
}

/** removePluginMeta：仅移除数据目录入口（ui / 控制台等），保留安装目录与配置 */
function removePluginMetaOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  try {
    if (renderProc && renderProc.child) {
      renderProc.abort = true;
      try {
        renderProc.child.kill();
      } catch {}
      renderProc = null;
    }
  } catch {}
  const ui = join(remotionRoot(), "ui");
  try {
    if (fs.existsSync(ui)) fs.rmSync(ui, { recursive: true, force: true });
  } catch {}
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

/* ------------------------------------------------------------------ */
/* IPC 注册                                                            */
/* ------------------------------------------------------------------ */
function registerRemotionIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  getDsh = typeof opts.getDsh === "function" ? opts.getDsh : null;

  ensureUiRuntime();
  refreshStaleLock();
  /* 安装 skill（skills/remotion-local-install/SKILL.md）同步进本机 dsh-home：
     安装窗 / 报错弹窗点「交给 mtnode 会话修复」时，会话就用它按现场修。 */
  syncRemotionInstallSkill();

  /* 报错总线：注册宿主。remotion 没有 dsh 安装链（安装 = npm install），所以只给
     「取可用安装目录」与「取日志尾部」两个能力入口 —— 报告照发，「自动修复」不隐藏；
     本宿主也无常驻服务，修完由渲染层（app-repair.js 的 resident:false 分支）走
     「重跑报错节点」收尾，因此不注册 restart / selfRepair。
     本轮补上 skillName：修复会话据此加载 remotion-local-install（以前是空，会话只能自己瞎猜）。 */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "Remotion 动效视频",
    skillName: INSTALL_SKILL,
    getInstallDir: () => usableInstallDir(),
    tailConsole: (n) => consoleTail(n),
  });
  /* 安装窗登记：卡片「安装 / 重装」与控制台窗内的「安装」都开这只窗
     （步骤真源 = 该包 steps.json，脚本按协议逐步上报） */
  installHost.registerInstallTarget({
    id: PLUGIN_ID,
    key: "remotion",
    name: "Remotion 动效视频",
    skill: INSTALL_SKILL,
    kindLabel: "本地后端",
    packRoots: [bundledPackRoot()],
    getInstallDir: () => loadConfig().installDir || "",
    cancel: async () => {
      installCancel = true;
      /* 光置标志没用：脚本在下载依赖期间不会自己退出，标志要等它结束后才被读到。
         这里立刻按进程树强杀（npm / node 这些子进程一并带走），close 回调据此判「已取消」。 */
      return await installKill.cancelInstall(PLUGIN_ID);
    },
  });

  /* installDir 可得性核对：目录不可得时报告只剩日志尾部一个现场，先记一行说清现状 */
  auditReportBusSources();

  ipcMain.handle("remotion:getStatus", async () => statusForUi());
  ipcMain.handle("remotion:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("remotion:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    const ready = runtimeReadyAt(safe.path);
    if (ready) {
      writeJson(installedMetaPath(), {
        ok: true,
        version: remotionVersionAt(safe.path) || "0.0.0",
        installDir: safe.path,
        discovered: true,
        installedAt: new Date().toISOString(),
      });
    }
    return { ok: true, installDir: safe.path, runtimeReady: ready };
  });
  /* 安装窗入口（两处共用）：卡片与控制台窗都走它 */
  ipcMain.handle("remotion:install", async (e, opts) => {
    installHost.beginPluginInstall({
      id: PLUGIN_ID,
      action: opts && opts.action === "update" ? "update" : "install",
      installDir: loadConfig().installDir || "",
    });
    return installProject(opts || {});
  });
  ipcMain.handle("remotion:cancelInstall", async () => {
    installCancel = true;
    return await installKill.cancelInstall(PLUGIN_ID);
  });
  ipcMain.handle("remotion:render", async (e, params) => renderVideo(params || {}));
  /* 短试渲染：构建验证 / 设置窗「试渲染」。不占全局音视频锁、产物即弃，见 verifyRender。 */
  ipcMain.handle("remotion:verify", async (e, params) => verifyRender(params || {}));
  /* 自定义合成参数预览（只读、不渲染）：按与真正渲染同一口径算「本次会传给合成的 props」，
     让画布设置窗与 Agent 能核对参数是否被通道接住。 */
  ipcMain.handle("remotion:resolveProps", async (e, params) => {
    const p = params || {};
    try {
      const mode = renderModeOf(p);
      const fromInputs = propsFromInputs(p.inputs, []);
      const bag = customPropsOf(p);
      const merged = Object.assign({}, mode === "custom" ? fromInputs : {}, bag.props);
      return {
        ok: true,
        mode,
        baseKeys: mode === "builtin" ? ["hero", "narration", "voice", "lineStarts", "bg"] : ["title", "subtitle", "bgColor", "audioPath"],
        props: merged,
        keys: Object.keys(merged),
        warnings: bag.warnings,
        note:
          mode === "builtin"
            ? "内置台词卡模板只读 hero / narration / voice / lineStarts / bg，其余键不会生效"
            : "自定义合成：接线文本里声明的 props + 节点参数里的未知键 + 参数文件会一并注入",
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("remotion:cancelRender", async (e, nodeId) => cancelRender(nodeId));
  ipcMain.handle("remotion:getLock", async () => ({ ok: true, lock: refreshStaleLock() }));
  ipcMain.handle("remotion:consoleTail", async (e, n) => consoleTail(n));
  /* 环境自检（本轮新增）：只读地查 node / npm、目录可写、磁盘、npm 源、随包脚手架与安装脚本，
     回一份逐项报告（控制台窗把它显示出来）。**不写日志文件**：连点几次不该把日志刷满；
     安装链的那份预检（同一份 environmentCheck）才逐行落盘。 */
  ipcMain.handle("remotion:selfcheck", async () => {
    try {
      const rep = await environmentCheck({});
      /* 两个 ok 语义分家，别混：ok = 「自检这一趟跑成功了」（调用方据此判回执可用），
         pass = 「环境这一趟检查通过了」（必需项全过）。控制台按 pass 决定要不要报警。 */
      return Object.assign({}, rep, { ok: true, pass: !!rep.ok, lines: formatEnvironmentReport(rep) });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  /* 清空日志 = 真清文件（不是只清界面显示），见 clearConsoleLog */
  ipcMain.handle("remotion:consoleClear", async () => clearConsoleLog());
  ipcMain.handle("remotion:open", async () => openConsoleWindow());
  ipcMain.handle("remotion:close", async () => closeConsoleWindow());
  ipcMain.handle("remotion:removePluginMeta", async () => removePluginMetaOnly());
  ipcMain.handle("remotion:freeDisk", async () => {
    const cfg = loadConfig();
    const dir = cfg.installDir || app.getPath("home");
    const freeGb = await freeDiskGb(dir);
    return { ok: true, freeGb, needGb: DISK_HINT_GB };
  });
}

/** 应用退出时只关控制台窗；渲染子进程 / 安装目录一律保留（同 h3 服务常驻语义）。 */
function shutdownRemotionUiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
}

module.exports = {
  registerRemotionIpc,
  shutdownRemotionUiOnly,
  statusForUi,
  PLUGIN_ID,
  DISK_HINT_GB,
  /* 纯函数件：供冒烟测试直接驱动同一份实现（生产路径只用内部调用，不依赖这条导出） */
  normalizeCustomComposition,
  /* 固化工程（多文件）+ 端子契约：文件树消毒 / 逐文件校验 / 契约解析 / props 组装 */
  projectRelPath,
  projectResolveImport,
  validateProjectTree,
  normalizeContract,
  parseContractLiteral,
  contractPropsOf,
  mediaExtOfMime,
  writeRenderSources,
};

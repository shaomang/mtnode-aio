"use strict";
/* ============ 内置能力库（Agent 指示 + 内置技能）的读写内核 ============
 *
 * 目的（用户需求）：把「整个应用里注入给模型的固定提示词」和「内置技能 SKILL.md」
 * 统一收进设置里的一页来管理，用户可改、可恢复默认；作者账号（ms2308）在开发态
 * 还能把改动写回源码路径，即覆盖随包默认。
 *
 * 三层取值（优先级从高到低）：
 *   1. 覆盖层  <数据目录>\builtin-overrides\agent-prompts.json   ← 普通用户改的
 *   2. 源码默认可编辑层  <仓库根>\agent-prompts\<id>.md          ← 作者「覆盖到源码」写的
 *   3. 代码内联默认  renderer / 主进程里 PS(id, def) 的 def      ← 出厂值，永不改
 * 第三层不在本文件里：调用点自带默认值，本文件只负责回答「这个 id 有没有更高优先级的文本」。
 * 这样拆分前后拼接结果逐字一致（没有覆盖时 PS 原样返回 def），升级也不会冲掉用户改动。
 *
 * 技能同理：
 *   覆盖层 <数据目录>\builtin-overrides\builtin-skills.json（name → 正文）
 *   写回目标是随包 skills/<name>/SKILL.md 或 mtnode-agent-skills/<cat>/<name>/SKILL.md。
 *
 * 「仓库根」怎么找（contentRoot）：appRoot（开发态 = 仓库根；打包态 = 里面的 app.asar）
 * 与 process.execPath（打包态 = <仓库根>\dist\win-unpacked\MTNodeAIO.exe，上三级即仓库根）
 * 两条链一起试，命中「含 main.js + mtnode-agent-skills/（或 skills/）且可写」的目录才算数。
 * 本机开发账号 ms2308 **跑的就是打包版**（dist\win-unpacked），源码树就在它上四级的磁盘上，
 * 所以「打包版」不是不能写回的理由 —— 找不到可写源码根才是。
 *
 * 作者写回的两条硬约束（共识）：
 *   · 只有登录账号 = ms2308、且找得到**可写的源码根**时才允许写回；别的账号一律
 *     canWrite:false，界面上不出现该按钮。
 *   · 写之前先把原文件备份到 agent-prompts/.source-backup/（时间戳文件名），可还原。
 *
 * 本文件不依赖 electron（app / I18n 一律由调用方传入），便于 test/ 下的冒烟脚本直接 require。
 */

const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = "agent-prompts";
const PROMPTS_INDEX = "index.json";
const FORMAT = "mtnode-agent-prompts-v1";
const SKILLS_FORMAT = "mtnode-builtin-skills-v1";

const OVERRIDE_DIR = "builtin-overrides";
const PROMPT_OVERRIDE_FILE = "agent-prompts.json";
const SKILL_OVERRIDE_FILE = "builtin-skills.json";
const BACKUP_DIR = ".source-backup";

const AUTHOR_ACCOUNT = "ms2308";
/* 仓库根的识别物：有这两个目录之一才算「源码树」，避免把用户安装目录当成源码写 */
const SOURCE_MARKERS = ["mtnode-agent-skills", "skills"];

function readJson(p, fb) {
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j == null ? fb : j;
  } catch {
    return fb;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function mkdirp(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/* 覆盖层文件路径 */
function overrideDir(dataDir) {
  return path.join(String(dataDir || ""), OVERRIDE_DIR);
}
function promptOverridePath(dataDir) {
  return path.join(overrideDir(dataDir), PROMPT_OVERRIDE_FILE);
}
function skillOverridePath(dataDir) {
  return path.join(overrideDir(dataDir), SKILL_OVERRIDE_FILE);
}

/* 覆盖层内容：{ format, items: { id: { text, at } } } */
function readPromptOverrides(dataDir) {
  const j = readJson(promptOverridePath(dataDir), null);
  const items = (j && j.items) || {};
  const out = {};
  for (const k of Object.keys(items)) {
    const it = items[k];
    if (it && typeof it.text === "string") out[k] = String(it.text);
  }
  return out;
}

function writePromptOverrides(dataDir, items) {
  const clean = {};
  let n = 0;
  for (const k of Object.keys(items || {})) {
    const t = items[k];
    if (typeof t !== "string" || !t.trim()) continue;
    clean[k] = { text: t, at: Date.now() };
    n++;
  }
  writeJson(promptOverridePath(dataDir), { format: FORMAT, count: n, items: clean });
  return n;
}

/* 源码默认可编辑层：<仓库根>/agent-prompts/<id>.md（id 里的 . 换成 __ 以免路径歧义） */
function sourceDir(appRoot) {
  return path.join(String(appRoot || ""), PROMPTS_DIR);
}
function sourceFileOf(appRoot, id) {
  /* id 只允许 [a-z0-9._-]（小写），入参已由调用点与界面约束；再兜一层防目录穿越 */
  const safe = String(id || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
  return path.join(sourceDir(appRoot), safe + ".md");
}

/* 清单：agent-prompts/index.json（随包）里的元数据 + 三层的实际存在性 */
function readIndex(appRoot) {
  const j = readJson(path.join(sourceDir(appRoot), PROMPTS_INDEX), null);
  if (!j || !Array.isArray(j.items)) return { format: FORMAT, groups: [], items: [] };
  return {
    format: j.format || FORMAT,
    groups: Array.isArray(j.groups) ? j.groups : [],
    items: j.items,
  };
}

/* ── 代码内联默认的静态抽取（设置页「出厂默认」兜底） ──────────────────────
 * 为什么需要它：PS(id, def) 的 def 只有在「那段代码真的被跑到」时才被登记，
 * 于是「设置 → 内置能力」里没跑过的档位就是一个空框 —— 连作者也没法把它的默认写回源码。
 * 怎么抽：只认「源码里就唯一确定」的几种写法，宁可空着也不猜：
 *   · 纯字符串字面量拼接（含 \n 等转义）
 *   · 同文件里能被同样算出来的字符串常量（GRILL_CONTRACT 这类 const）
 *   · 纯包裹调用 X("…") / X.y("…")（I18n.t / appsDevT 这类，参数原文就是默认）
 *   · id 与 def 是**同构三元**（逐层条件一致）时按分支配对 ——
 *     assistCanvasFree ? "…canvas_free" : "…canvas" 配 personaHost 的两支
 * 抽不到就返回空（多档共用一个 id、函数内拼装、join / 模板插值等），界面按「取不到」显示。
 */
const SCAN_TTL_MS = 120000;
const scanCache = { root: "", at: 0, map: null };

function stripJsComments(src) {
  const out = String(src).split("");
  let i = 0;
  const n = out.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

function isIdStart(c) {
  return !!c && /[A-Za-z_$]/.test(c);
}
function isIdChar(c) {
  return !!c && /[\w$]/.test(c);
}
function skipSpace(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/* 读一个字符串字面量（"…" '…' 与不含 ${} 的 `…`）；带插值的模板一律不认 */
function readStringLit(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let out = "";
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      i += 2;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "b") out += "\b";
      else if (n === "f") out += "\f";
      else if (n === "v") out += "\v";
      else if (n === "0") out += "\0";
      else if (n === "x") {
        out += String.fromCharCode(parseInt(s.substr(i, 2), 16) || 0);
        i += 2;
      } else if (n === "u") {
        if (s[i] === "{") {
          const e = s.indexOf("}", i);
          if (e < 0) return null;
          out += String.fromCodePoint(parseInt(s.slice(i + 1, e), 16) || 0);
          i = e + 1;
        } else {
          out += String.fromCharCode(parseInt(s.substr(i, 4), 16) || 0);
          i += 4;
        }
      } else if (n === "\n") {
        /* 续行 */
      } else out += n == null ? "" : n;
      continue;
    }
    if (c === q) return { value: out, end: i + 1 };
    if (q === "`" && c === "$" && s[i + 1] === "{") return null;
    if (c === "\n" && q !== "`") return null;
    out += c;
    i++;
  }
  return null;
}

function readAtom(s, i, consts, depth) {
  if (depth > 8) return null;
  i = skipSpace(s, i);
  const lit = readStringLit(s, i);
  if (lit) return lit;
  if (s[i] === "(") {
    const inner = readConcatExpr(s, i + 1, consts, depth + 1);
    if (!inner) return null;
    const j = skipSpace(s, inner.end);
    if (s[j] !== ")") return null;
    return { value: inner.value, end: j + 1 };
  }
  if (!isIdStart(s[i])) return null;
  let j = i;
  while (isIdChar(s[j])) j++;
  const name = s.slice(i, j);
  let k = j;
  while (s[k] === "." && isIdStart(s[k + 1])) {
    k++;
    while (isIdChar(s[k])) k++;
  }
  const callee = s.slice(i, k);
  const p = skipSpace(s, k);
  /* 纯包裹调用：只认「纯文本包装器」白名单（I18n.t / appsDevT 这类），
     且必须恰好一个参数 —— 别把 lines.join("\n") 当成默认正文 */
  if (s[p] === "(" && /^(I18n\.t|[A-Za-z_$][\w$]*T)$/.test(callee)) {
    const arg = readConcatExpr(s, p + 1, consts, depth + 1);
    if (!arg) return null;
    let e = skipSpace(s, arg.end);
    if (s[e] === ",") e = skipSpace(s, e + 1); /* 尾随逗号 */
    if (s[e] !== ")") return null;
    return { value: arg.value, end: e + 1 };
  }
  if (callee === name && Object.prototype.hasOwnProperty.call(consts, name))
    return { value: consts[name], end: j };
  return null;
}

function readConcatExpr(s, i, consts, depth) {
  if (depth > 8) return null;
  i = skipSpace(s, i);
  const first = readAtom(s, i, consts, depth);
  if (!first) return null;
  let out = first.value;
  let j = first.end;
  for (;;) {
    const k = skipSpace(s, j);
    if (s[k] !== "+") return { value: out, end: j };
    const nx = readAtom(s, k + 1, consts, depth);
    if (!nx) return null;
    out += nx.value;
    j = nx.end;
  }
}

/* 顶层三元拆分（右结合：a ? b : c ? d : e ⇒ {cond:a, a:b, b:"c ? d : e"}） */
function parseTernary(expr) {
  let depth = 0;
  let q = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      const qq = c;
      i++;
      while (i < expr.length) {
        if (expr[i] === "\\") {
          i += 2;
          continue;
        }
        if (expr[i] === qq) break;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?") {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  let depth2 = 0;
  let nested = 0;
  for (let i = q + 1; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      const qq = c;
      i++;
      while (i < expr.length) {
        if (expr[i] === "\\") {
          i += 2;
          continue;
        }
        if (expr[i] === qq) break;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth2++;
    else if (c === ")" || c === "]" || c === "}") depth2--;
    else if (depth2 === 0 && c === "?") nested++;
    else if (depth2 === 0 && c === ":") {
      if (!nested)
        return {
          cond: expr.slice(0, q).replace(/\s+/g, " ").trim(),
          a: expr.slice(q + 1, i).trim(),
          b: expr.slice(i + 1).trim(),
        };
      nested--;
    }
  }
  return null;
}

/* 三元树 → 叶子清单 [{ path:[cond…], expr }]，顺序 = 书写顺序 */
function ternaryLeaves(expr, path, out, depth) {
  const node = depth > 8 ? null : parseTernary(expr);
  if (!node) {
    out.push({ path: path.slice(), expr: expr.trim() });
    return;
  }
  ternaryLeaves(node.a, path.concat(node.cond), out, depth + 1);
  ternaryLeaves(node.b, path.concat(node.cond), out, depth + 1);
}

/* 同文件里的 const 赋值：name → 表达式原文（顶层与函数内都收，靠求值阶段筛） */
const CONST_DEF_RE = /(?:^|[;{}\n])[ \t]*(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*/g;

function exprEndOf(s, i) {
  let depth = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && c === ";") return i;
    if (depth === 0 && c === "\n") {
      /* 换行是否续接：**上一个非空字符**是运算符（表达式写到这里断了），
         或**下一个非空字符**是运算符 / 右括号（表达式在下一行接着写）。
         两条任一成立就续 —— 这是 ASI 的近似：
         `const a = cond\n ? "x"`（前瞻 ?）与 `"a" +\n name`（回看 +）都要接，
         而 `const a = "x"\n foo()`（前瞻 f 不是运算符）要断。 */
      const OPS = "+-*/%?:,.)]}&|=<>!~^([";
      let b = i - 1;
      while (b >= 0 && /\s/.test(s[b])) b--;
      let f = i + 1;
      while (f < n && /\s/.test(s[f])) f++;
      if (OPS.indexOf(s[b] || "") >= 0 || OPS.indexOf(s[f] || "") >= 0) {
        i = f;
        continue;
      }
      return i;
    }
    i++;
  }
  return n;
}

function constsOf(text) {
  const map = Object.create(null);
  CONST_DEF_RE.lastIndex = 0;
  let m;
  while ((m = CONST_DEF_RE.exec(text))) {
    const name = m[1];
    let start = m.index + m[0].length;
    while (start < text.length && /\s/.test(text[start])) start++;
    const end = exprEndOf(text, start);
    if (!map[name]) map[name] = text.slice(start, end).trim();
  }
  /* 多轮：常量可以引用别的常量 */
  const vals = Object.create(null);
  for (let pass = 0; pass < 4; pass++) {
    let progressed = false;
    for (const name of Object.keys(map)) {
      if (typeof vals[name] === "string") continue;
      const r = readConcatExpr(map[name], 0, vals, 0);
      if (r && !map[name].slice(r.end).trim().replace(/^\)+$/, "").trim()) {
        vals[name] = r.value;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return vals;
}

/* 表达式 → 字符串值（算不出就空串；不猜） */
function resolveExpr(expr, consts) {
  const text = String(expr || "").trim();
  if (!text) return "";
  const r = readConcatExpr(text, 0, consts, 0);
  if (r && !text.slice(r.end).trim()) return r.value;
  return "";
}

/* 把 def 表达式展开成它的定义（只展开一层标识符），供三元配对用 */
function expandDef(expr, constDefs, depth) {
  let text = String(expr || "").trim();
  for (let i = 0; i < (depth || 2); i++) {
    if (!/^[A-Za-z_$][\w$]*$/.test(text)) break;
    const def = constDefs[text];
    if (!def) break;
    text = def;
  }
  return text;
}

const PS_SITE_RE = /(?<![\w$.])PS[ \t\r\n]*\(/g;

function splitCallArgs(s, i) {
  const args = [];
  let depth = 0;
  let cur = "";
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const st = i;
      const q = c;
      i++;
      while (i < n) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === q) {
          i++;
          break;
        }
        i++;
      }
      cur += s.slice(st, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      cur += c;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        args.push(cur);
        return args;
      }
      depth--;
      cur += c;
      i++;
      continue;
    }
    if (c === "," && depth === 0) {
      args.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  return args;
}

/* 扫一份源码 → { id: 默认文本 }（只含唯一能确定的） */
function scanSourceText(text, out) {
  let clean = "";
  try {
    clean = stripJsComments(text);
  } catch {
    return out;
  }
  if (clean.indexOf("PS(") < 0) return out;
  const consts = constsOf(clean);
  PS_SITE_RE.lastIndex = 0;
  let m;
  while ((m = PS_SITE_RE.exec(clean))) {
    const args = splitCallArgs(clean, m.index + m[0].length);
    if (!args || args.length < 2) continue;
    const idExpr = args[0].trim();
    const defExpr = args[1].trim();
    if (!idExpr || !defExpr) continue;
    const idTree = parseTernary(idExpr);
    if (!idTree) {
      const id = resolveExpr(idExpr, consts, 0);
      if (!id || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) continue;
      const def = resolveExpr(defExpr, consts, 0);
      if (!def) continue;
      if (!out[id] || out[id].length < def.length) out[id] = def;
      continue;
    }
    /* id 是多档：def 必须是同构三元，逐支配对（条件链必须完全一致，否则不猜） */
    const idLeaves = [];
    ternaryLeaves(idExpr, [], idLeaves, 0);
    const defLeaves = [];
    ternaryLeaves(expandDef(defExpr, rawConstsOf(clean)), [], defLeaves, 0);
    if (idLeaves.length !== defLeaves.length) continue;
    let same = true;
    for (let i = 0; i < idLeaves.length; i++) {
      if (idLeaves[i].path.join(">") !== defLeaves[i].path.join(">")) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    for (let i = 0; i < idLeaves.length; i++) {
      const id = resolveExpr(idLeaves[i].expr, consts, 0);
      const def = resolveExpr(defLeaves[i].expr, consts, 0);
      if (!id || !def) continue;
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) continue;
      if (!out[id] || out[id].length < def.length) out[id] = def;
    }
  }
  return out;
}

/* 原始 const 定义（可能是三元，求不出字符串，但分支配对要用它的形状） */
function rawConstsOf(text) {
  const key = String(text || "");
  const map = Object.create(null);
  CONST_DEF_RE.lastIndex = 0;
  let m;
  while ((m = CONST_DEF_RE.exec(key))) {
    const name = m[1];
    let start = m.index + m[0].length;
    while (start < text.length && /\s/.test(text[start])) start++;
    const end = exprEndOf(key, start);
    if (!map[name]) map[name] = key.slice(start, end).trim();
  }
  return map;
}

/* 随包快照：构建期把「源码扫描结果」落成 agent-prompts/defaults.json，
   这样没有源码树的普通用户机也能看到出厂默认，而不是一片空白。
   快照只是兜底 —— 现场扫到的永远优先，也允许 asar 内读（Electron 的 fs 认 asar）。 */
function readDefaultsSnapshot(opts) {
  const o = opts || {};
  const cands = [];
  try {
    const cr = contentRoot(o);
    if (cr) cands.push(cr);
  } catch {}
  if (o.appRoot) cands.push(String(o.appRoot));
  for (const base of cands) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(base, "agent-prompts", "defaults.json"), "utf8"));
      const texts = raw && raw.texts && typeof raw.texts === "object" ? raw.texts : null;
      if (!texts) continue;
      const out = Object.create(null);
      for (const k of Object.keys(texts)) {
        const v = texts[k];
        if (typeof v === "string" && v) out[k] = v;
      }
      if (!Object.keys(out).length) continue;
      return { map: out, at: String(raw.generatedAt || ""), from: base };
    } catch {}
  }
  return null;
}

/* 入口：扫源码树里的 renderer / 根目录 js，抽「出厂默认」 */
function scanPromptDefaults(opts) {
  const o = opts || {};
  const roots = [];
  const push = (p) => {
    try {
      if (p && !isAsarPath(p) && roots.indexOf(path.resolve(p)) < 0) roots.push(path.resolve(p));
    } catch {}
  };
  push(contentRoot(o));
  push(o.appRoot);
  const root = roots[0] || "";
  const snap = o.ignoreSnapshot ? null : readDefaultsSnapshot(o);
  const now = Date.now();
  const cacheKey = roots.join("|") + "||" + String(o.appRoot || "");
  if (scanCache.map && scanCache.root === cacheKey && now - scanCache.at < SCAN_TTL_MS)
    return scanCache.map;
  const map = Object.create(null);
  const files = [];
  const collect = (dir, depth) => {
    if (depth > 2 || files.length > 120) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === "data") continue;
        collect(full, depth + 1);
      } else if (/\.js$/i.test(ent.name)) files.push(full);
    }
  };
  /* root 为空（打包版只有 asar、没有源码树）时绝不能拼出相对路径去扫当前目录 */
  if (root) {
    collect(path.join(root, "renderer"), 0);
    let top = [];
    try {
      top = fs.readdirSync(root, { withFileTypes: true });
    } catch {}
    for (const ent of top) if (ent.isFile() && /\.js$/i.test(ent.name)) files.push(path.join(root, ent.name));
  }
  let scanned = 0;
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (text.indexOf("PS(") < 0) continue;
    scanned++;
    try {
      scanSourceText(text, map);
    } catch {}
  }
  /* 现场扫不到的，用随包快照补（快照是构建期同一套扫描的产物） */
  let snapUsed = 0;
  if (snap) {
    for (const k of Object.keys(snap.map)) {
      if (!map[k]) {
        map[k] = snap.map[k];
        snapUsed++;
      }
    }
  }
  scanCache.root = cacheKey;
  scanCache.at = now;
  scanCache.map = {
    ok: true,
    map,
    files: scanned,
    root,
    snapshot: snap ? { from: snap.from, at: snap.at, filled: snapUsed } : null,
  };
  return scanCache.map;
}

/* 主查询：返回每个 id 的生效文本与来源（override / source / default）
 * 源码默认层一律从 contentRoot 读：作者「覆盖到源码」写进仓库根以后，
 * 连正在跑的打包版也立刻按它当默认（否则写了半天还是随包 asar 里那份旧的）。 */
function catalog(opts) {
  const o = opts || {};
  const appRoot = String(o.appRoot || "");
  const dataDir = String(o.dataDir || "");
  const readRoot = contentRoot(o);
  const idx = readIndex(appRoot);
  const overrides = readPromptOverrides(dataDir);
  /* 代码里那一段的「出厂默认」：只取源码里唯一能确定的（见 scanPromptDefaults），
     抽不到就空 —— 设置页据此决定是「载入默认」还是「取不到，按源码位置显示」 */
  let scanned = Object.create(null);
  try {
    scanned = (scanPromptDefaults(o) || {}).map || Object.create(null);
  } catch {}
  const items = idx.items.map((it) => {
    const id = String(it.id || "");
    const src = sourceFileOf(readRoot, id);
    const srcText = readText(src);
    const ov = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : null;
    const source = ov != null ? "override" : srcText ? "source" : "default";
    const effective = ov != null ? ov : srcText;
    return {
      id,
      title: String(it.title || id),
      group: String(it.group || "session"),
      desc: String(it.desc || ""),
      where: String(it.where || ""),
      vars: Array.isArray(it.vars) ? it.vars : [],
      text: effective,
      source,
      hasOverride: ov != null,
      hasSource: !!srcText,
      sourceText: srcText,
      defaultText: String(scanned[id] || ""),
      /* 覆盖正文与源码默认一字不差 = 作者写回后那次（或用户改成了与默认一样的文本） */
      sameAsSource: !!srcText && (ov != null ? ov === srcText : true),
      sourcePath: srcText ? src : "",
      bytes: (effective || "").length,
    };
  });
  return {
    ok: true,
    format: idx.format,
    groups: idx.groups,
    items,
    overrides: Object.keys(overrides).length,
    /* 默认层落在哪（设置页显示「源码默认 = <这个目录>/agent-prompts/<id>.md」） */
    defaultRoot: readRoot,
    hasSourceRoot: readRoot !== appRoot && !!readRoot,
  };
}

/* 渲染层与主进程取文本用：{ id: text }（只含被覆盖 / 有源码默认的那些） */
function texts(opts) {
  const o = opts || {};
  const appRoot = String(o.appRoot || "");
  const dataDir = String(o.dataDir || "");
  const readRoot = contentRoot(o);
  const idx = readIndex(appRoot);
  const overrides = readPromptOverrides(dataDir);
  const out = {};
  for (const it of idx.items) {
    const id = String(it.id || "");
    if (!id) continue;
    if (Object.prototype.hasOwnProperty.call(overrides, id)) out[id] = overrides[id];
    else {
      const srcText = readText(sourceFileOf(readRoot, id));
      if (srcText) out[id] = srcText;
    }
  }
  /* 清单里没登记、却已有覆盖的 id 也要下发（作者手写 / 老清单），否则用户存了不生效 */
  for (const id of Object.keys(overrides)) if (!(id in out)) out[id] = overrides[id];
  /* 源码默认层同理：作者写回了 .md 但清单还没重建时，PS 也得拿到它（否则写了不生效） */
  try {
    const dir = sourceDir(readRoot);
    for (const ent of fs.readdirSync(dir)) {
      if (!/\.md$/i.test(ent)) continue;
      const id = ent.replace(/\.md$/i, "");
      if (id in out) continue;
      const t = readText(path.join(dir, ent));
      if (t) out[id] = t;
    }
  } catch {}
  return { ok: true, texts: out };
}

function setOverride(opts, id, text) {
  const o = opts || {};
  const dataDir = String(o.dataDir || "");
  const key = String(id || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(key)) return { ok: false, error: "BAD_ID" };
  const cur = readPromptOverrides(dataDir);
  const t = String(text == null ? "" : text);
  if (!t.trim()) {
    delete cur[key];
    writePromptOverrides(dataDir, cur);
    return { ok: true, id: key, cleared: true };
  }
  cur[key] = t;
  writePromptOverrides(dataDir, cur);
  return { ok: true, id: key, bytes: t.length };
}

function clearOverride(opts, id) {
  return setOverride(opts, id, "");
}

function clearAllOverrides(opts) {
  writePromptOverrides(String((opts || {}).dataDir || ""), {});
  return { ok: true };
}

/* ── 作者写回源码 ────────────────────────────────────────────────────────── */

/* 源码根识别：asar 虚拟路径永远不可写，先剔掉 */
function isAsarPath(p) {
  return /\.asar([\\/]|$)/i.test(String(p || ""));
}

/* 候选目录：appRoot 及其上四级、exe 上三级、本文件所在目录、MTNODE_DEV_ROOT。
 * 与 main.js 的 selfRebuildDirs 同一口径（开发态 / 打包态两种布局都能推回仓库根）。 */
function candidateRoots(opts) {
  const o = opts || {};
  const out = [];
  const push = (p) => {
    try {
      if (!p) return;
      const abs = path.resolve(String(p));
      if (isAsarPath(abs)) return;
      if (out.indexOf(abs) < 0) out.push(abs);
    } catch {}
  };
  push(o.appRoot);
  push(process.env.MTNODE_DEV_ROOT);
  const base = String(o.appRoot || ".");
  try {
    push(path.resolve(base, ".."));
    push(path.resolve(base, "..", ".."));
    push(path.resolve(base, "..", "..", ".."));
    push(path.resolve(base, "..", "..", "..", ".."));
  } catch {}
  try {
    push(path.resolve(String(o.execPath || process.execPath), "..", "..", ".."));
  } catch {}
  return out;
}

/* 像不像源码树：main.js + mtnode-agent-skills/（或 skills/）同时存在 */
function hasSourceMarkers(base) {
  try {
    if (!fs.existsSync(path.join(base, "main.js"))) return false;
    return SOURCE_MARKERS.some((m) => fs.existsSync(path.join(base, m)));
  } catch {
    return false;
  }
}

/* 可写探测：不改目录结构（目录不存在就探父目录），避免读路径上顺手建目录 */
function canWriteDir(dir) {
  if (!dir) return false;
  const probeOf = (d) => path.join(d, ".write-probe-" + process.pid + ".tmp");
  try {
    if (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (!fs.existsSync(parent)) return false;
      const probe = probeOf(parent);
      fs.writeFileSync(probe, "1");
      fs.rmSync(probe, { force: true });
      return true;
    }
    const probe = probeOf(dir);
    fs.writeFileSync(probe, "1");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/* 所有像源码树的候选（带可写标记），作者态诊错与写回都看这一份 */
function scanSourceRoots(opts) {
  const out = [];
  for (const base of candidateRoots(opts)) {
    if (!hasSourceMarkers(base)) continue;
    out.push({ root: base, writable: canWriteDir(path.join(base, PROMPTS_DIR)) });
  }
  return out;
}

/* 源码根（可写的那个；找不到回空串） */
function findSourceRoot(opts) {
  for (const hit of scanSourceRoots(opts)) if (hit.writable) return hit.root;
  return "";
}

/* 「默认层」读哪：有源码根就读源码根（作者覆盖到源码后立刻成为全应用的默认），
 * 普通用户装上没有源码树 → 退回 appRoot（随包 asar 里那份，等于没有 .md 默认层）。 */
function contentRoot(opts) {
  const o = opts || {};
  return findSourceRoot(o) || String(o.appRoot || "");
}

/* 作者态：{ author, account, sourceRoot, canWrite, reason, roots, tried } */
function authorInfo(opts) {
  const o = opts || {};
  const account = String(o.account || "").trim();
  const isAuthor = account.toLowerCase() === AUTHOR_ACCOUNT;
  const hits = scanSourceRoots(o);
  const writable = hits.find((h) => h.writable) || null;
  const root = writable ? writable.root : "";
  const reason = !isAuthor
    ? "NOT_AUTHOR"
    : !hits.length
      ? "NO_SOURCE_ROOT"
      : !writable
        ? "SOURCE_READONLY"
        : "";
  return {
    ok: true,
    author: isAuthor,
    account,
    packaged: !!o.packaged,
    sourceRoot: root,
    sourceDir: root ? sourceDir(root) : "",
    canWrite: !reason,
    reason,
    roots: hits.map((h) => h.root),
    tried: candidateRoots(o),
  };
}

/* 备份：把即将被覆盖的源文件复制到 .source-backup/<id>.<ts>.md（同一秒内多次写也不冲掉） */
function backupSource(appRoot, id) {
  const src = sourceFileOf(appRoot, id);
  if (!fs.existsSync(src)) return "";
  const dir = path.join(sourceDir(appRoot), BACKUP_DIR);
  mkdirp(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, path.basename(src, ".md") + "." + stamp + ".md");
  try {
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return "";
  }
}

/* 写回一条：text = 界面里当前生效的正文（＝作者认可的新默认）。
 * 同时清掉覆盖层——否则下次仍是覆盖优先，看起来像「写了没生效」。 */
function writeSource(opts, id, text) {
  const o = opts || {};
  const info = authorInfo(o);
  if (!info.canWrite) return { ok: false, error: info.reason || "NOT_ALLOWED" };
  const key = String(id || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(key)) return { ok: false, error: "BAD_ID" };
  const t = String(text == null ? "" : text);
  if (!t.trim()) return { ok: false, error: "EMPTY_TEXT" };
  if (!mkdirp(sourceDir(info.sourceRoot))) return { ok: false, error: "SOURCE_READONLY" };
  const backup = backupSource(info.sourceRoot, key);
  try {
    fs.writeFileSync(sourceFileOf(info.sourceRoot, key), t, "utf8");
  } catch (e) {
    return { ok: false, error: "WRITE_FAILED", detail: String((e && e.message) || e) };
  }
  if (o.clearOverride !== false) clearOverride(o, key);
  /* becameDefault = 这一条从此就是全应用的默认（源码层 > 代码内联），设置页据此换成「源码默认」 */
  return {
    ok: true,
    id: key,
    path: sourceFileOf(info.sourceRoot, key),
    backup,
    becameDefault: true,
    root: info.sourceRoot,
  };
}

function writeSourceAll(opts, texts) {
  const o = opts || {};
  const info = authorInfo(o);
  if (!info.canWrite) return { ok: false, error: info.reason || "NOT_ALLOWED" };
  const map = texts && typeof texts === "object" ? texts : {};
  const done = [];
  const failed = [];
  for (const id of Object.keys(map)) {
    const r = writeSource(o, id, map[id]);
    if (r.ok) done.push(id);
    else failed.push({ id, error: r.error });
  }
  return { ok: true, written: done, failed };
}

/* ── 内置技能覆盖 ───────────────────────────────────────────────────────── */

function readSkillOverrides(dataDir) {
  const j = readJson(skillOverridePath(dataDir), null);
  const items = (j && j.items) || {};
  const out = {};
  for (const k of Object.keys(items)) {
    const it = items[k];
    if (it && typeof it.text === "string") out[k] = String(it.text);
  }
  return out;
}

function writeSkillOverrides(dataDir, items) {
  const clean = {};
  let n = 0;
  for (const k of Object.keys(items || {})) {
    const t = items[k];
    if (typeof t !== "string" || !t.trim()) continue;
    clean[k] = { text: t, at: Date.now() };
    n++;
  }
  writeJson(skillOverridePath(dataDir), { format: SKILLS_FORMAT, count: n, items: clean });
  return n;
}

function skillListOverrides(dataDir) {
  const map = readSkillOverrides(dataDir);
  return { ok: true, names: Object.keys(map) };
}

function skillSetOverride(dataDir, name, body) {
  const nm = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nm)) return { ok: false, error: "BAD_NAME" };
  const cur = readSkillOverrides(dataDir);
  const t = String(body == null ? "" : body);
  if (!t.trim()) {
    delete cur[nm];
    writeSkillOverrides(dataDir, cur);
    return { ok: true, name: nm, cleared: true };
  }
  cur[nm] = t;
  writeSkillOverrides(dataDir, cur);
  return { ok: true, name: nm, bytes: t.length };
}

function skillClearOverride(dataDir, name) {
  return skillSetOverride(dataDir, name, "");
}

/* 同步 / 读取链上应用覆盖：命中就整份替换 SKILL.md 正文（front matter 由覆盖正文自带，
 * 用户改坏的 front matter 只会让该技能在索引里名字不对，不会污染其他技能） */
function applySkillOverride(dataDir, name, body) {
  const nm = String(name || "").trim().toLowerCase();
  const map = readSkillOverrides(dataDir);
  return Object.prototype.hasOwnProperty.call(map, nm) ? map[nm] : body;
}

/* SKILL.md 的 front matter 里那行 name:（技能对外的名字，索引与「/」菜单都用它）。
   目录名 ≠ 技能名是常态：mtnode-agent-skills/mtnode/self-check/SKILL.md 的技能名是
   mtnode-self-check —— 只按目录名找会一个都找不到，所以两套名字都要认。 */
function skillNameOfFile(file) {
  const txt = readText(file);
  if (!txt) return "";
  /* 只吃文件头那一段 front matter，正文里出现 name: 不当真 */
  const m = /^---\r?\n([\s\S]{0,1200}?)\r?\n---/.exec(txt);
  if (!m) return "";
  const n = /\bname:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})/.exec(m[1]);
  return n ? n[1].toLowerCase() : "";
}

/* 在源码树里找某个技能的 SKILL.md（skills/ 与 mtnode-agent-skills/ 两棵树都走）。
   认三种写法：目录名 = 技能名、目录名 = 去掉 mtnode- 前缀的技能名、front matter 的 name = 技能名。 */
function findSkillFile(root, name) {
  const nm = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nm) || !root) return "";
  const bare = nm.replace(/^mtnode-/, "");
  let exact = "";
  const dirs = [];
  try {
    const walk = (base, depth) => {
      if (depth > 3 || exact) return;
      let ents = [];
      try {
        ents = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith(".")) continue;
        const full = path.join(base, ent.name);
        const file = path.join(full, "SKILL.md");
        if (fs.existsSync(file)) {
          if (ent.name === nm) {
            exact = file; /* 目录名直中：最优先 */
            return;
          }
          dirs.push({ dir: ent.name, file });
        }
        walk(full, depth + 1);
      }
    };
    walk(path.join(root, "skills"), 0);
    walk(path.join(root, "mtnode-agent-skills"), 0);
  } catch {}
  if (exact) return exact;
  /* 第二轮：先按「mtnode- 前缀 / 去掉前缀」猜目录名，再读 front matter 认名字 */
  for (const d of dirs) {
    if (d.dir === bare || "mtnode-" + d.dir === nm) return d.file;
  }
  for (const d of dirs) {
    if (skillNameOfFile(d.file) === nm) return d.file;
  }
  return "";
}

/* 技能的「源码默认」正文（设置页比差异 / 判断「是否已与源码一致」用） */
function skillSourceBody(opts, name) {
  const o = opts || {};
  const nm = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nm)) return { ok: false, error: "BAD_NAME" };
  const root = contentRoot(o);
  const file = findSkillFile(root, nm);
  return {
    ok: true,
    name: nm,
    body: file ? readText(file) : "",
    path: file,
    root,
  };
}

/* 技能稿写回源码：作者态下把正文写回随包 SKILL.md（先备份），并清掉该技能的覆盖层 */
function skillWriteSource(opts, name, body) {
  const o = opts || {};
  const info = authorInfo(o);
  if (!info.canWrite) return { ok: false, error: info.reason || "NOT_ALLOWED" };
  const nm = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nm)) return { ok: false, error: "BAD_NAME" };
  const target = findSkillFile(info.sourceRoot, nm);
  if (!target) return { ok: false, error: "SKILL_NOT_IN_SOURCE" };
  /* 空正文会把一本技能写成空文件（技能从此读不出内容）—— 一律拒写 */
  const text = String(body == null ? "" : body);
  if (!text.trim()) return { ok: false, error: "EMPTY_TEXT" };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(path.dirname(target), "SKILL.md." + stamp + ".bak");
  try {
    fs.copyFileSync(target, backup);
    fs.writeFileSync(target, text, "utf8");
  } catch (e) {
    return { ok: false, error: "WRITE_FAILED", detail: String((e && e.message) || e) };
  }
  skillClearOverride(o.dataDir, nm);
  return { ok: true, name: nm, path: target, backup, becameDefault: true };
}

module.exports = {
  PROMPTS_DIR,
  PROMPTS_INDEX,
  FORMAT,
  SKILLS_FORMAT,
  OVERRIDE_DIR,
  AUTHOR_ACCOUNT,
  BACKUP_DIR,
  promptOverridePath,
  skillOverridePath,
  readIndex,
  catalog,
  scanPromptDefaults,
  texts,
  setOverride,
  clearOverride,
  clearAllOverrides,
  authorInfo,
  findSourceRoot,
  scanSourceRoots,
  candidateRoots,
  hasSourceMarkers,
  contentRoot,
  writeSource,
  writeSourceAll,
  readSkillOverrides,
  skillListOverrides,
  skillSetOverride,
  skillClearOverride,
  applySkillOverride,
  findSkillFile,
  skillSourceBody,
  skillWriteSource,
};

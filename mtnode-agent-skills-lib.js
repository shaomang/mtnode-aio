"use strict";

const fs = require("fs");
const path = require("path");

/* v2：条目多了 devOnly（仓库内部开发纪律技能，只在开发态进索引）。
   格式变了就必须换版本号 —— readIndexAt 认不出的老 index.json 会整树重建一次，
   否则盘上那份 v1 索引没有 devOnly 标记，普通用户照样在系统提示里看到开发技能。 */
const INDEX_FORMAT = "mtnode-agent-skills-index-v2";

/* ── dev-only：给「改 MTNode 自己」用的内部开发纪律技能 ────────────────────────
   普通用户既用不到、也没法照做（要源码树 / 要 MCP 自服务 / 要往网关树补装依赖），
   它们每轮在系统提示的技能索引里各占一行纯属噪声，用 agent 工具点开还会读到
   「改 MTNode 自身功能时怎么验」这类与产品使用无关的指令。
   名字取 front matter 的 name（不是目录名）。新加这一类技能，把 name 补进这张表。
   gateway-capability-install 不在内置库里（随包已下线，见 build.json），列在这里是
   表态：万一哪天又进库，它同样不许出现在普通用户的索引里。 */
const DEV_ONLY_SKILLS = [
  "mtnode-app-dev",
  "mtnode-plugin-dev",
  "mtnode-verify-in-app",
  "mtnode-dev-architect",
  "mtnode-mcp-server",
  "gateway-capability-install",
];
const LIB_DIR = "mtnode-agent-skills";
const CATEGORY_TITLES = {
  mtnode: "MTNode 产品与画布",
  app: "应用开发",
  plugins: "插件与后端",
  canvas: "画布工作流模板",
  music: "音乐生成（MiniMax Music）",
  video: "视频生成（MiniMax H3）",
  image: "图像生成（Qwen Image）",
  writing: "写作与润色",
  film: "AI 影视创作",
  remotion: "Remotion 视频制作",
  coding: "编码准则与代码评审",
};

/* 二级分组标题：类目目录下再按阶段 / 主题分子目录（如 film/script/…、remotion/animation/…）。
   只影响索引与 INDEX.md 的分组小标题，不影响技能的安装目录名（安装名取 front matter 的 name）。
   新加一组要在这里补标题，否则索引里直接显示目录名。 */
const GROUP_TITLES = {
  "film/script": "剧本与创意开发",
  "film/storyboard": "分镜与镜头设计",
  "film/asset": "角色与场景资产",
  "film/prompt": "生成提示词工程",
  "film/audio": "声音与字幕",
  "film/post": "剪辑与成片交付",
  "remotion/components": "工程与组件",
  "remotion/animation": "动画与时序",
  "remotion/audio-subtitle": "音频与字幕",
  "remotion/data-params": "参数化与数据",
  "remotion/render-deploy": "渲染与发布",
};

function groupTitle(category, group) {
  if (!group) return "";
  return GROUP_TITLES[category + "/" + group] || group;
}

function bundledRoot(appRoot) {
  return path.join(appRoot || path.join(__dirname), LIB_DIR);
}

function dshLibRoot(dshHome) {
  return path.join(dshHome, LIB_DIR);
}

/* 开发态判据（决定 DEV_ONLY_SKILLS 进不进模型索引 / INDEX.md）。
   三个信号任一成立即算，顺序＝便宜到贵：
     ① 显式开关：调用方给 opts.devMode（true / false 都是确定性结论，冒烟靠它钉口径），
        或环境变量 MTNODE_DEV_DEBUG=1（与 mtnode_dev 调试工具同一个开关，不新造一枚）。
     ② 作者账号：opts.account 命中 agent-prompts-lib 的 AUTHOR_ACCOUNT
        （账号字符串不在本文件抄第二份）。
     ③ 可写源码根：agent-prompts-lib.findSourceRoot 找得到「有 main.js + mtnode-agent-skills/
        且可写」的仓库根 —— 与「覆盖到源码」、技能源目录（main-dsh 的 skillsSourceRoot）
        完全同一份口径。打包态 appRoot 在 app.asar 里、用户机上没有源码树，一律 false。
   判不出真假一律当「非开发态」：宁可不展示，也不把内部开发纪律推给终端用户。 */
function devSkillMode(opts) {
  const o = opts || {};
  if (o.devMode === true || o.devMode === false) return o.devMode;
  if (String(process.env.MTNODE_DEV_DEBUG || "") === "1") return true;
  let lib = null;
  try {
    lib = require("./agent-prompts-lib.js");
  } catch {
    lib = null; /* 老沙箱只抠本文件时缺这个模块也不至于整块炸（同 skillOverridesOf） */
  }
  const author = lib ? String(lib.AUTHOR_ACCOUNT || "").trim().toLowerCase() : "";
  if (author && String(o.account || "").trim().toLowerCase() === author) return true;
  try {
    /* 没给 appRoot（冒烟 / 工具直接调渲染函数）时以**本文件所在目录**为准：
       开发态它就是仓库根（有 main.js + mtnode-agent-skills/ 且可写）；打包态本文件在
       app.asar 里，candidateRoots 的 isAsarPath 会把它整条排除，结论仍是 false。 */
    if (
      lib &&
      lib.findSourceRoot({
        appRoot: o.appRoot || __dirname,
        execPath: o.execPath || process.execPath,
      })
    )
      return true;
  } catch {}
  return false;
}

/* 给模型看的索引视图：非开发态滤掉 devOnly 的技能；整个类目被滤空则连同类目标题一起删
   （否则会留下一个只有标题、下面空空的分组）。
   只影响「渲染出来的文本」（compactIndexText → 系统提示；renderIndexMd → INDEX.md），
   index.json 与 mtnodeAgentSkillIndex().index 仍是全量 —— 内置能力面板要能列全、能改全，
   用户可见性的判据仍然是 menu: user（skillList 那条线一个字没动）。 */
function modelVisibleIndex(index, opts) {
  if (devSkillMode(opts)) return index;
  const cats = [];
  for (const cat of (index && index.categories) || []) {
    const skills = (cat.skills || []).filter((s) => !s || !s.devOnly);
    if (!skills.length) continue;
    cats.push(Object.assign({}, cat, { skills }));
  }
  return Object.assign({}, index, { categories: cats });
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

/* tags：只进 index.json（界面检索 / 分类看板用），不拼进每次会话注入的紧凑索引，
   免得几十条技能 × 若干 tag 在白送的上下文里重复一遍。两种写法都认：
     tags: 分镜, 镜头语言            （行内，逗号 / 顿号 / 分号分隔，可带 []）
     tags:\n  - 分镜\n  - 镜头语言    （YAML 块状列表） */
function normalizeTags(raw, block) {
  const out = [];
  const push = (s) => {
    const v = String(s || "")
      .replace(/^[\[【]\s*/, "")
      .replace(/\s*[\]】]$/, "")
      .replace(/^['"]|['"]$/g, "")
      .trim();
    if (!v) return;
    const t = v.slice(0, 24);
    if (!out.includes(t)) out.push(t);
  };
  for (const part of String(raw || "").split(/[,，、;；]/)) push(part);
  for (const t of block || []) push(t);
  return out.slice(0, 12);
}

function parseSkillMeta(text) {
  const meta = { name: "", title: "", description: "", version: "", menu: "", tags: [] };
  /* 先归一换行：SKILL.md 若被 Windows 编辑器存成 CRLF，行尾的 \r 会让
     /^key:\s*(.*)$/ 里的 `.` 吃不掉它（`.` 不匹配 \r），整行匹配失败 →
     front matter 全部读空 → name 退回目录名（如 dev-architect 而不是
     mtnode-dev-architect），同步时就会把技能装到错名字下并删掉正确命名的目录。 */
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const body = fm ? fm[2] || "" : raw;
  if (fm) {
    let curKey = "";
    const blockTags = [];
    for (const line of fm[1].split("\n")) {
      const km = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!km) {
        const li = line.match(/^\s*-\s+(.+)$/);
        if (li && curKey === "tags") blockTags.push(String(li[1]).trim());
        continue;
      }
      curKey = km[1];
      const k = km[1];
      const v = String(km[2] || "")
        .replace(/^['"]|['"]$/g, "")
        .trim();
      if (k === "name") meta.name = v;
      if (k === "title") meta.title = v;
      if (k === "description") meta.description = v;
      if (k === "version") meta.version = v;
      if (k === "tags") meta.tags = v;
      /* menu: user —— 这条内置技能要在用户的技能列表 / 「/」菜单里出现（标「内置」只读），
         缺省不写 = 纯内部纪律技能，只进内置索引，不进用户技能清单。 */
      if (k === "menu") meta.menu = v;
    }
    meta.tags = normalizeTags(meta.tags, blockTags);
  }
  if (!meta.title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) meta.title = String(h1[1] || "").trim();
  }
  return meta;
}

function walkSkillFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      const r = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(full, r);
      else if (ent.name === "SKILL.md") out.push({ full, rel: r.replace(/\\/g, "/") });
    }
  };
  walk(root, "");
  return out;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmDirSafe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function flattenIndex(index) {
  const out = [];
  for (const cat of index.categories || []) {
    for (const sk of cat.skills || []) out.push({ ...sk, category: cat.id, categoryTitle: cat.title });
  }
  return out;
}

function buildIndexFromTree(root) {
  const byCategory = new Map();
  for (const hit of walkSkillFiles(root)) {
    const rel = hit.rel.replace(/\\/g, "/");
    const parts = rel.split("/");
    if (parts.length < 2) continue;
    const category = parts[0];
    const skillFolder = parts.slice(0, -1).join("/");
    const body = fs.readFileSync(hit.full, "utf8");
    const meta = parseSkillMeta(body);
    const name = String(meta.name || path.basename(skillFolder)).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) continue;
    /* 四段路径（film/script/xxx/SKILL.md）= 类目 + 阶段分组 + 技能；
       两段路径（app/impeccable/SKILL.md）的第二段是技能目录本身，不是分组。 */
    const group = parts.length >= 4 ? parts[1] : "";
    const entry = {
      id: path.basename(skillFolder),
      name,
      title: String(meta.title || name).slice(0, 80),
      description: String(meta.description || "").slice(0, 400),
      path: rel,
      version: String(meta.version || "").slice(0, 32),
    };
    if (group) entry.group = group;
    if (Array.isArray(meta.tags) && meta.tags.length) entry.tags = meta.tags;
    /* front matter 写了 menu: user → 这条内置技能同时进用户的技能清单（标「内置」、只读、
       不可卸载 / 覆盖），「/」菜单与助手技能菜单都点得到；缺省 = 只进内置索引给模型看。 */
    if (meta.menu === "user") entry.menu = "user";
    /* 仓库内部开发纪律技能：标注进索引条目，渲染时按开发态判据决定去留（见 devSkillMode） */
    if (DEV_ONLY_SKILLS.indexOf(name) >= 0) entry.devOnly = true;
    if (!byCategory.has(category)) {
      byCategory.set(category, {
        id: category,
        title: CATEGORY_TITLES[category] || category,
        skills: [],
      });
    }
    byCategory.get(category).skills.push(entry);
  }
  const categories = [...byCategory.values()]
    .map((c) => {
      c.skills.sort((a, b) => a.name.localeCompare(b.name));
      return c;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    format: INDEX_FORMAT,
    updatedAt: new Date().toISOString(),
    libraryRoot: LIB_DIR,
    usage:
      "MTNode 内置 Agent 技能库。默认只注入本索引；任务匹配时再读取完整 SKILL.md（skill 工具或 read）。",
    categories,
  };
}

/* INDEX.md 的渲染。opts 同 compactIndexText：非开发态滤掉 devOnly 那几颗 ——
   INDEX.md 就躺在 dsh-home/mtnode-agent-skills/ 里，模型按「read 工具：路径
   $DSH_HOME/mtnode-agent-skills/<path>」是能读到它的，所以它也必须跟着开发态走。
   仓库里那份（mtnode-agent-skills/INDEX.md）由 tools/build-mtnode-agent-skill-index.js
   生成，固定传 devMode:true —— 它是文档源，永远列全。 */
function renderIndexMd(index, opts) {
  const vis = modelVisibleIndex(index, opts);
  const lines = [
    "# MTNode 内置 Agent 技能索引",
    "",
    "以下条目仅含摘要。**不要**一次性读取全部 SKILL.md。",
    "",
    "调取方式（任选其一）：",
    "1. `skill` 工具：`skill` 参数为下表 `name`（已注册到 DSH_HOME/skills：front matter 无 `menu` 的带 `.mtnode-internal` 标记，只在内置索引里对模型可见；写了 `menu: user` 的带 `.builtin` 标记，同时出现在用户技能清单与「/」菜单里，标「内置」只读）。",
    "2. `read` 工具：路径 `$DSH_HOME/mtnode-agent-skills/<path>`。",
    "",
  ];
  for (const cat of vis.categories || []) {
    lines.push("## " + (cat.title || cat.id));
    lines.push("");
    let lastGroup = "";
    for (const sk of cat.skills || []) {
      const g = sk.group || "";
      if (g !== lastGroup) {
        lastGroup = g;
        if (g) {
          lines.push("### " + groupTitle(cat.id, g));
          lines.push("");
        }
      }
      lines.push(
        "- **" +
          sk.name +
          "** — " +
          (sk.title || sk.id) +
          "：" +
          (sk.description || "（无描述）"),
      );
      lines.push("  - 文件：`" + sk.path + "`");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function writeIndexArtifacts(root, index, opts) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "INDEX.md"), renderIndexMd(index, opts), "utf8");
}

function readIndexAt(root) {
  const p = path.join(root, "index.json");
  const index = readJson(p, null);
  if (index && index.format === INDEX_FORMAT && Array.isArray(index.categories)) return index;
  return buildIndexFromTree(root);
}

/* 「一句话」：取 description 的第一个分句（到第一个「。；;」或英文句点 + 空格截止），
   再压到 60 字以内。compactIndexText 已改成只给「名字 + title」不再带它，
   这里保留给需要短摘要的调用方（与冒烟的口径）。 */
function skillIndexOneLiner(desc) {
  const s = String(desc || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = /[。；;]|\.\s/.exec(s);
  let one = m && m.index > 0 ? s.slice(0, m.index) : s;
  one = one.trim();
  if (one.length > 60) one = one.slice(0, 59) + "…";
  return one;
}

/* 系统提示里的紧凑索引。opts（devMode / account / appRoot）见 devSkillMode：
   非开发态不出现 dev-only（仓库内部开发纪律）技能的条目，也不留下被滤空的类目标题。 */
function compactIndexText(index, maxChars, opts) {
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 6000;
  const lines = [
    "【MTNode 内置技能索引】仅摘要；匹配任务后再用 skill 工具（name 如下）或 read 读取完整 SKILL.md。",
    "",
  ];
  /* 只给「名字 + 极短标签（title）」：技能描述本来就随引擎技能目录一起下发，
     这里再抄一遍一句话（每条约 60 字）只是同一份信息在系统提示里的第二份拷贝。
     按名 skill 调用靠 name，触发判断靠 title；完整描述 / 正文仍由 skill 工具给。 */
  for (const cat of modelVisibleIndex(index, opts).categories || []) {
    lines.push("[" + (cat.title || cat.id) + "]");
    for (const sk of cat.skills || []) {
      lines.push("- " + sk.name + " | " + (sk.title || sk.id));
    }
    lines.push("");
  }
  let text = lines.join("\n").trim();
  if (text.length > cap) text = text.slice(0, cap - 20) + "\n…（索引已截断）";
  return text;
}

/* ── 同步的「没变就不动」快路径（本轮修：会话输入框打字略显卡顿）─────────────
   病根：skillList()（渲染层「/」候选与技能清单都打它）每次调用都**无条件**整树重建 ——
   rm -rf 内置库 → 重拷 1MB / 119 个文件 → 逐个读 SKILL.md 算 sha256 → 重写 index.json /
   INDEX.md → 再按技能逐个删目录、重拷。实测 106–140ms/次纯同步 I/O，全都在主进程线程上；
   而渲染层 loadSkillsCached 只缓存 5 秒，于是「一边打字一边每 5 秒来一次」——
   主进程这 100 多毫秒里 IPC 不响应，会话 / 应用开发输入框就跟着一顿。
   做法：把「源树指纹 + 上次装出来的出处」记在库根的 .mtnode-skills-sync.json，
   指纹一致且目标盘上该有的都在，就直接返回上次那份索引（不再碰任何文件）。
   指纹 = 源树每个 SKILL.md 的相对路径 / 字节数 / mtime（源树随包，升级换文件必变），
   再叠一个 SYNC_FORMAT：**同步算法的形态变了**（比如以后多写一个标记文件）就手动 +1，
   老标记格式对不上即整树重建一次 —— 免得算法升级后快路径把新产物漏装。
   缺文件 / 缺标记 / 多出一个该回收的内置目录，一律退回整树重建（升级自愈的口径不变）。 */
const SYNC_STATE_FILE = ".mtnode-skills-sync.json";
/* 3：多了一步「把覆盖层正文写进同步出来的技能树」（设置 →「内置能力」里改的 SKILL.md）。
   4：INDEX.md 的内容开始随「开发态」变（非开发态滤掉 dev-only 技能），
      开发态标志因此也进了指纹（见 syncMtnodeAgentSkills 里的 devMode）——
      判据翻转时必须整树重建一次，否则盘上那份 INDEX.md 会停在旧口径。
   形态一变就 +1，老标记对不上即整树重建一次。 */
const SYNC_FORMAT = 4;

function srcTreeFingerprint(src) {
  const parts = [];
  for (const hit of walkSkillFiles(src)) {
    let st = null;
    try {
      st = fs.statSync(hit.full);
    } catch {
      st = null;
    }
    parts.push(
      hit.rel.replace(/\\/g, "/") + ":" + (st ? st.size : -1) + ":" + (st ? Math.round(st.mtimeMs) : -1),
    );
  }
  parts.sort();
  return parts.join("|");
}

/* 内置技能覆盖层（<数据目录>/builtin-overrides/builtin-skills.json，见 agent-prompts-lib.js）。
   内核按需 require：老沙箱只抠本文件时缺这个模块也不至于整块炸。 */
function skillOverridesOf(dataDir) {
  if (!dataDir) return {};
  try {
    return require("./agent-prompts-lib.js").readSkillOverrides(dataDir) || {};
  } catch {
    return {};
  }
}

function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s == null ? "" : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/* 覆盖层里改过的正文，同步时逐条写进目标树（按 front matter name 优先、目录名兜底）。
   与 buildIndexFromTree 取值口径一致，用户改了 front matter 也不会锁死旧名字。 */
function applySkillOverridesToTree(root, overrides) {
  const names = Object.keys(overrides || {});
  if (!names.length) return 0;
  let n = 0;
  for (const hit of walkSkillFiles(root)) {
    let body = "";
    try {
      body = fs.readFileSync(hit.full, "utf8");
    } catch {
      continue;
    }
    const meta = parseSkillMeta(body);
    const dirName = path.basename(path.dirname(hit.full));
    const name = String(meta.name || dirName).trim().toLowerCase();
    const key = Object.prototype.hasOwnProperty.call(overrides, name)
      ? name
      : Object.prototype.hasOwnProperty.call(overrides, dirName.toLowerCase())
        ? dirName.toLowerCase()
        : "";
    if (!key) continue;
    try {
      fs.writeFileSync(hit.full, String(overrides[key]), "utf8");
      n++;
    } catch {}
  }
  return n;
}

/* 目标盘上「该有的都在吗」：库根两个产物 + 每颗技能的 SKILL.md 与应有的出处标记。
   只做 existsSync（13 颗技能 = 40 来次 stat），比整树重建便宜两个数量级。 */
function syncStateUsable(prev, dist, skillsRoot) {
  if (!prev || prev.format !== SYNC_FORMAT || !Array.isArray(prev.skills)) return false;
  if (!fs.existsSync(path.join(dist, "index.json"))) return false;
  if (!fs.existsSync(path.join(dist, "INDEX.md"))) return false;
  for (const sk of prev.skills) {
    if (!sk || !sk.name || !sk.path) return false;
    if (!fs.existsSync(path.join(dist, sk.path))) return false;
    const dir = path.join(skillsRoot, sk.name);
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) return false;
    const visible = !!sk.visible;
    if (!fs.existsSync(path.join(dir, visible ? ".builtin" : ".mtnode-internal"))) return false;
    if (visible && !fs.existsSync(path.join(dir, ".mtnode-builtin"))) return false;
  }
  const keep = new Set(prev.skills.map((s) => s.name));
  try {
    for (const ent of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || keep.has(ent.name)) continue;
      const dir = path.join(skillsRoot, ent.name);
      if (
        fs.existsSync(path.join(dir, ".mtnode-internal")) ||
        fs.existsSync(path.join(dir, ".mtnode-builtin"))
      )
        return false; /* 库里已下线的内置技能还留着 → 走整树重建把它回收掉 */
    }
  } catch {
    return false;
  }
  return true;
}

/* 写同步标记：只记「源树指纹 + 装出来的是什么」，不记时间戳（免得每次同步都写盘） */
function writeSyncState(dist, fingerprint, skills, count) {
  try {
    fs.writeFileSync(
      path.join(dist, SYNC_STATE_FILE),
      JSON.stringify({ format: SYNC_FORMAT, fingerprint, count, skills }, null, 2) + "\n",
      "utf8",
    );
  } catch {}
}

function syncMtnodeAgentSkills(dshHome, appRoot, dataDir, opts) {
  const src = bundledRoot(appRoot);
  const dest = dshLibRoot(dshHome);
  if (!fs.existsSync(src)) return { ok: false, error: "bundled library missing: " + src };
  const skillsRoot0 = path.join(dshHome, "skills");
  /* 覆盖层参与指纹：用户改了某颗内置技能的正文，也要让快路径失效、整树重建一次，
     否则同步出来的 dsh-home/skills 里还是旧正文（症状：设置里改完、模型读到的没变）。 */
  const skillOverrides = skillOverridesOf(dataDir);
  const ovKey = Object.keys(skillOverrides)
    .sort()
    .map((k) => k + "≈" + shortHash(skillOverrides[k]))
    .join("|");
  /* 开发态标志也参与指纹：INDEX.md 的正文随它变（非开发态滤掉 dev-only 技能），
     判据翻转时必须重建一次，不能靠快路径把旧口径的 INDEX.md 一直留着。
     一次同步只判一次，下面三处渲染都用这个结果（免得同一次同步里探两遍源码根、
     也免得指纹与正文取自两个不同结论）。 */
  const devMode = devSkillMode(Object.assign({ appRoot, execPath: process.execPath }, opts || {}));
  const modeOpts = Object.assign({}, opts, { devMode });
  const fingerprint = srcTreeFingerprint(src) + "||ov:" + ovKey + "||dev:" + (devMode ? "1" : "0");
  const prev = readJson(path.join(dest, SYNC_STATE_FILE), null);
  if (prev && prev.fingerprint === fingerprint && syncStateUsable(prev, dest, skillsRoot0)) {
    const index = readIndexAt(dest);
    const indexMd = fs.existsSync(path.join(dest, "INDEX.md"))
      ? fs.readFileSync(path.join(dest, "INDEX.md"), "utf8")
      : renderIndexMd(index, modeOpts);
    return {
      ok: true,
      count: flattenIndex(index).length,
      index,
      indexMd,
      compact: compactIndexText(index, 0, modeOpts),
      libraryPath: dest,
      skipped: true,
    };
  }
  rmDirSafe(dest);
  copyDir(src, dest);
  /* 覆盖层正文写进刚同步出来的树（front matter 也一并覆盖），索引随后按覆盖后的正文重建 */
  const ovApplied = applySkillOverridesToTree(dest, skillOverrides);
  /* 索引一律按**落盘后的技能树**重建，不信任随包携带的 index.json：
     它可能被手工改过 / 忘了跑 tools/build-mtnode-agent-skill-index.js，
     而下面的安装目录名取自索引条目 name —— 索引里 name 写错（如少了 mtnode- 前缀）
     就会把技能装到错名字下，并把原本正确命名的 .mtnode-internal 目录当「已下线」清掉，
     表现就是内置技能凭空消失。以 SKILL.md front matter 的 name 为准才不会丢。 */
  const index = buildIndexFromTree(dest);
  writeIndexArtifacts(dest, index, modeOpts);
  const skillsRoot = path.join(dshHome, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  const keepNames = new Set(flattenIndex(index).map((s) => s.name));
  for (const sk of flattenIndex(index)) {
    const skillSrcDir = path.join(dest, path.dirname(sk.path));
    const skillDestDir = path.join(skillsRoot, sk.name);
    if (!fs.existsSync(skillSrcDir)) continue;
    rmDirSafe(skillDestDir);
    copyDir(skillSrcDir, skillDestDir);
    /* 两种标记，二选一：
       - menu: user（如 minimax-music-prompt / -lyrics）→ 写 .builtin（+ .mtnode-builtin
         作为「这条归内置库管」的出处标记）。这类技能随包内置、替代原先从创意工坊下载的那份，
         要照常出现在用户技能清单与「/」菜单里，并被宿主按「内置」保护（不可覆盖 / 不可卸载）。
       - 其余（画布规范 / 开发架构等产品内部纪律）→ 写 .mtnode-internal，skillList 不展示。
       两边都清掉另一套标记，改 front matter 的 menu 后不必删 dsh-home 也能收敛。 */
    const visible = sk.menu === "user";
    try {
      fs.rmSync(path.join(skillDestDir, visible ? ".mtnode-internal" : ".builtin"), { force: true });
      fs.writeFileSync(
        path.join(skillDestDir, visible ? ".builtin" : ".mtnode-internal"),
        "1\n",
        "utf8",
      );
      if (visible) fs.writeFileSync(path.join(skillDestDir, ".mtnode-builtin"), "1\n", "utf8");
      else fs.rmSync(path.join(skillDestDir, ".mtnode-builtin"), { force: true });
    } catch {}
  }
  /* 清理已从内置库移除的技能：只删带本机内置标记（.mtnode-internal / .mtnode-builtin）的目录，
     用户自建技能与工坊下载的技能一律不动 */
  try {
    for (const ent of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (keepNames.has(ent.name)) continue;
      const dir = path.join(skillsRoot, ent.name);
      if (
        fs.existsSync(path.join(dir, ".mtnode-internal")) ||
        fs.existsSync(path.join(dir, ".mtnode-builtin"))
      )
        rmDirSafe(dir);
    }
  } catch {}
  const indexMd = fs.existsSync(path.join(dest, "INDEX.md"))
    ? fs.readFileSync(path.join(dest, "INDEX.md"), "utf8")
    : renderIndexMd(index, modeOpts);
  /* 落同步标记：下一次 skillList 只要源树没变就走快路径（见文件上方 SYNC_STATE_FILE 段） */
  const flat = flattenIndex(index);
  writeSyncState(
    dest,
    fingerprint,
    flat.map((s) => ({ name: s.name, path: s.path, visible: s.menu === "user" })),
    flat.length,
  );
  return {
    ok: true,
    count: flat.length,
    index,
    indexMd,
    compact: compactIndexText(index, 0, modeOpts),
    libraryPath: dest,
  };
}

function getMtnodeAgentSkill(dshHome, name, dataDir) {
  const nm = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nm)) {
    return { ok: false, error: "技能不存在" };
  }
  const lib = dshLibRoot(dshHome);
  const index = readIndexAt(lib);
  const hit = flattenIndex(index).find((s) => s.name === nm);
  if (!hit) return { ok: false, error: "技能不存在" };
  const skillMd = path.join(lib, hit.path);
  if (!fs.existsSync(skillMd)) return { ok: false, error: "技能不存在" };
  let body = fs.readFileSync(skillMd, "utf8");
  /* 覆盖层优先（快路径未重建时 lib 树里仍是随包正文，这里再兜一层，读到的永远是用户改过的那份） */
  const ovs = skillOverridesOf(dataDir);
  if (Object.prototype.hasOwnProperty.call(ovs, nm)) body = String(ovs[nm]);
  const files = [];
  const skillDir = path.dirname(skillMd);
  try {
    const walk = (base, prefix) => {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        const rel = prefix ? prefix + "/" + ent.name : ent.name;
        const full = path.join(base, ent.name);
        if (ent.isDirectory()) walk(full, rel);
        else if (rel.replace(/\\/g, "/") !== "SKILL.md") {
          const buf = fs.readFileSync(full);
          files.push({
            path: rel.replace(/\\/g, "/"),
            bytes: buf.length,
            base64: buf.toString("base64"),
          });
        }
      }
    };
    walk(skillDir, "");
  } catch {}
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    name: nm,
    body,
    title: hit.title || nm,
    description: hit.description || "",
    category: hit.category || "",
    path: hit.path,
    files,
    internal: true,
  };
}

/* opts（可选）= devSkillMode 的判据：{ devMode?, account?, appRoot?, execPath? }。
   主进程按登录账号 + 可写源码根传一份进来，让「系统提示里的索引 / INDEX.md」与
   「开发态」始终是同一个结论。一次调用只判一次，两处渲染共用（见 syncMtnodeAgentSkills）。 */
function mtnodeAgentSkillIndex(dshHome, appRoot, dataDir, opts) {
  const modeOpts = Object.assign({}, opts, {
    devMode: devSkillMode(Object.assign({ appRoot, execPath: process.execPath }, opts || {})),
  });
  const lib = dshLibRoot(dshHome);
  if (!fs.existsSync(path.join(lib, "index.json"))) {
    const synced = syncMtnodeAgentSkills(dshHome, appRoot, dataDir, modeOpts);
    if (!synced.ok) return synced;
    return {
      ok: true,
      index: synced.index,
      indexMd: synced.indexMd,
      compact: synced.compact,
      count: synced.count,
      libraryPath: synced.libraryPath,
    };
  }
  const index = readIndexAt(lib);
  const indexMd = fs.existsSync(path.join(lib, "INDEX.md"))
    ? fs.readFileSync(path.join(lib, "INDEX.md"), "utf8")
    : renderIndexMd(index, modeOpts);
  return {
    ok: true,
    index,
    indexMd,
    compact: compactIndexText(index, 0, modeOpts),
    count: flattenIndex(index).length,
    libraryPath: lib,
  };
}

module.exports = {
  LIB_DIR,
  INDEX_FORMAT,
  DEV_ONLY_SKILLS,
  CATEGORY_TITLES,
  GROUP_TITLES,
  groupTitle,
  devSkillMode,
  modelVisibleIndex,
  normalizeTags,
  bundledRoot,
  dshLibRoot,
  parseSkillMeta,
  walkSkillFiles,
  buildIndexFromTree,
  renderIndexMd,
  writeIndexArtifacts,
  readIndexAt,
  compactIndexText,
  skillIndexOneLiner,
  syncMtnodeAgentSkills,
  getMtnodeAgentSkill,
  mtnodeAgentSkillIndex,
  flattenIndex,
};

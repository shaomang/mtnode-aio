"use strict";

const fs = require("fs");
const path = require("path");

const INDEX_FORMAT = "mtnode-agent-skills-index-v1";
const LIB_DIR = "mtnode-agent-skills";
const CATEGORY_TITLES = {
  mtnode: "MTNode 产品与画布",
  plugins: "插件与后端",
  canvas: "画布工作流模板",
};

function bundledRoot(appRoot) {
  return path.join(appRoot || path.join(__dirname), LIB_DIR);
}

function dshLibRoot(dshHome) {
  return path.join(dshHome, LIB_DIR);
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function parseSkillMeta(text) {
  const meta = { name: "", title: "", description: "", version: "" };
  const raw = String(text || "");
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const body = fm ? fm[2] || "" : raw;
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const km = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!km) continue;
      const k = km[1];
      const v = String(km[2] || "")
        .replace(/^['"]|['"]$/g, "")
        .trim();
      if (k === "name") meta.name = v;
      if (k === "title") meta.title = v;
      if (k === "description") meta.description = v;
      if (k === "version") meta.version = v;
    }
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
    const entry = {
      id: path.basename(skillFolder),
      name,
      title: String(meta.title || name).slice(0, 80),
      description: String(meta.description || "").slice(0, 400),
      path: rel,
      version: String(meta.version || "").slice(0, 32),
    };
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

function renderIndexMd(index) {
  const lines = [
    "# MTNode 内置 Agent 技能索引",
    "",
    "以下条目仅含摘要。**不要**一次性读取全部 SKILL.md。",
    "",
    "调取方式（任选其一）：",
    "1. `skill` 工具：`skill` 参数为下表 `name`（已注册到 DSH_HOME/skills，带 `.mtnode-internal` 标记）。",
    "2. `read` 工具：路径 `$DSH_HOME/mtnode-agent-skills/<path>`。",
    "",
  ];
  for (const cat of index.categories || []) {
    lines.push("## " + (cat.title || cat.id));
    lines.push("");
    for (const sk of cat.skills || []) {
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

function writeIndexArtifacts(root, index) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "INDEX.md"), renderIndexMd(index), "utf8");
}

function readIndexAt(root) {
  const p = path.join(root, "index.json");
  const index = readJson(p, null);
  if (index && index.format === INDEX_FORMAT && Array.isArray(index.categories)) return index;
  return buildIndexFromTree(root);
}

function compactIndexText(index, maxChars) {
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 6000;
  const lines = [
    "【MTNode 内置技能索引】仅摘要；匹配任务后再用 skill 工具（name 如下）或 read 读取完整 SKILL.md。",
    "",
  ];
  for (const cat of index.categories || []) {
    lines.push("[" + (cat.title || cat.id) + "]");
    for (const sk of cat.skills || []) {
      lines.push(
        "- " +
          sk.name +
          " | " +
          (sk.title || sk.id) +
          " | " +
          String(sk.description || "").replace(/\s+/g, " ").slice(0, 160),
      );
    }
    lines.push("");
  }
  let text = lines.join("\n").trim();
  if (text.length > cap) text = text.slice(0, cap - 20) + "\n…（索引已截断）";
  return text;
}

function syncMtnodeAgentSkills(dshHome, appRoot) {
  const src = bundledRoot(appRoot);
  const dest = dshLibRoot(dshHome);
  if (!fs.existsSync(src)) return { ok: false, error: "bundled library missing: " + src };
  rmDirSafe(dest);
  copyDir(src, dest);
  let index = readIndexAt(dest);
  if (!fs.existsSync(path.join(dest, "index.json"))) {
    index = buildIndexFromTree(dest);
    writeIndexArtifacts(dest, index);
  }
  const skillsRoot = path.join(dshHome, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  const keepNames = new Set(flattenIndex(index).map((s) => s.name));
  for (const sk of flattenIndex(index)) {
    const skillSrcDir = path.join(dest, path.dirname(sk.path));
    const skillDestDir = path.join(skillsRoot, sk.name);
    if (!fs.existsSync(skillSrcDir)) continue;
    rmDirSafe(skillDestDir);
    copyDir(skillSrcDir, skillDestDir);
    fs.writeFileSync(path.join(skillDestDir, ".mtnode-internal"), "1\n", "utf8");
    try {
      const builtin = path.join(skillDestDir, ".builtin");
      if (fs.existsSync(builtin)) fs.unlinkSync(builtin);
    } catch {}
  }
  /* 清理已从内置库移除的技能：只删带 .mtnode-internal 标记的目录，用户自建技能不动 */
  try {
    for (const ent of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (keepNames.has(ent.name)) continue;
      const dir = path.join(skillsRoot, ent.name);
      if (fs.existsSync(path.join(dir, ".mtnode-internal"))) rmDirSafe(dir);
    }
  } catch {}
  const indexMd = fs.existsSync(path.join(dest, "INDEX.md"))
    ? fs.readFileSync(path.join(dest, "INDEX.md"), "utf8")
    : renderIndexMd(index);
  return {
    ok: true,
    count: flattenIndex(index).length,
    index,
    indexMd,
    compact: compactIndexText(index),
    libraryPath: dest,
  };
}

function getMtnodeAgentSkill(dshHome, name) {
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
  const body = fs.readFileSync(skillMd, "utf8");
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

function mtnodeAgentSkillIndex(dshHome, appRoot) {
  const lib = dshLibRoot(dshHome);
  if (!fs.existsSync(path.join(lib, "index.json"))) {
    const synced = syncMtnodeAgentSkills(dshHome, appRoot);
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
    : renderIndexMd(index);
  return {
    ok: true,
    index,
    indexMd,
    compact: compactIndexText(index),
    count: flattenIndex(index).length,
    libraryPath: lib,
  };
}

module.exports = {
  LIB_DIR,
  INDEX_FORMAT,
  bundledRoot,
  dshLibRoot,
  parseSkillMeta,
  walkSkillFiles,
  buildIndexFromTree,
  renderIndexMd,
  writeIndexArtifacts,
  readIndexAt,
  compactIndexText,
  syncMtnodeAgentSkills,
  getMtnodeAgentSkill,
  mtnodeAgentSkillIndex,
  flattenIndex,
};

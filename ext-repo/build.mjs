/**
 * 从 ext-repo/ 生成 MTNode 扩展目录（skills 仅取自 ext-repo/skills）。
 * 输出: ext-repo/catalog.json 与 dist/ext-publish/（上传用）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const EXT = __dirname;
const OUT = path.join(ROOT, "dist", "ext-publish");
const PUBLIC_BASE = "http://mt-agent.com/mtnode/ext";

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function copyDir(src, dest) {
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function parseSkillMeta(text) {
  const meta = { name: "", title: "", description: "" };
  const fm = String(text || "").match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return meta;
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    const v = String(m[2] || "").replace(/^['"]|['"]$/g, "").trim();
    if (k === "name" || k === "title" || k === "description") meta[k] = v;
  }
  return meta;
}

function collectSkills() {
  const byId = new Map();
  const addRoot = (root) => {
    if (!fs.existsSync(root)) return;
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) continue;
      /* 插件安装用 skill 不进扩展目录（由 h3/music3 插件自行同步） */
      if (id.endsWith("-install")) continue;
      const md = path.join(root, id, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      const meta = parseSkillMeta(fs.readFileSync(md, "utf8"));
      byId.set(id, {
        id,
        name: meta.title || meta.name || id,
        description: meta.description || "",
        path: "skills/" + id + "/SKILL.md",
        srcDir: path.join(root, id),
      });
    }
  };
  /* 仅从 ext-repo/skills 发布；应用包 skills/ 留给插件安装用 */
  addRoot(path.join(EXT, "skills"));
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function collectMcp() {
  const dir = path.join(EXT, "mcp");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const j = readJson(path.join(dir, name), null);
    if (!j || !j.id) continue;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(j.id))) {
      throw new Error("bad mcp id: " + j.id);
    }
    out.push({
      id: String(j.id),
      name: String(j.name || j.id),
      description: String(j.description || ""),
      transport: j.transport === "http" ? "http" : "stdio",
      command: String(j.command || "npx.cmd"),
      args: String(j.args || ""),
      url: String(j.url || ""),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function collectPlugins() {
  const dir = path.join(EXT, "plugins");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const specPath = path.join(dir, ent.name, "plugin.json");
    if (!fs.existsSync(specPath)) continue;
    const j = readJson(specPath, null);
    if (!j || !j.id) continue;
    const install = String(j.install || j.tgz || "").trim();
    if (!install) throw new Error("plugin " + j.id + " missing install");
    out.push({
      id: String(j.id),
      name: String(j.name || j.id),
      description: String(j.description || ""),
      version: String(j.version || ""),
      install,
      srcDir: path.join(dir, ent.name),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function main() {
  const skills = collectSkills();
  const plugins = collectPlugins();
  const mcp = collectMcp();
  const catalog = {
    format: "mtnode-ext-v1",
    name: "MTNode Official",
    updatedAt: new Date().toISOString(),
    plugins: plugins.map(({ srcDir, ...p }) => p),
    skills: skills.map(({ srcDir, ...s }) => s),
    mcp,
  };

  fs.writeFileSync(
    path.join(EXT, "catalog.json"),
    JSON.stringify(catalog, null, 2) + "\n",
    "utf8",
  );

  rmrf(OUT);
  mk(OUT);
  fs.writeFileSync(
    path.join(OUT, "catalog.json"),
    JSON.stringify(catalog, null, 2) + "\n",
    "utf8",
  );

  for (const s of skills) {
    copyDir(s.srcDir, path.join(OUT, "skills", s.id));
  }
  for (const p of plugins) {
    copyDir(p.srcDir, path.join(OUT, "plugins", p.id));
  }
  if (mcp.length) {
    mk(path.join(OUT, "mcp"));
    for (const name of fs.readdirSync(path.join(EXT, "mcp"))) {
      if (!name.endsWith(".json")) continue;
      fs.copyFileSync(
        path.join(EXT, "mcp", name),
        path.join(OUT, "mcp", name),
      );
    }
  }

  console.log(
    "ext catalog " +
      PUBLIC_BASE +
      "/catalog.json · plugins " +
      plugins.length +
      " · skills " +
      skills.length +
      " · mcp " +
      mcp.length,
  );
  console.log("wrote " + path.join(EXT, "catalog.json"));
  console.log("staged " + OUT);
}

main();

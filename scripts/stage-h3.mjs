/**
 * 打包 H3 脚手架到 dist/h3-publish/。
 *
 * 用法:
 *   node scripts/stage-h3.mjs
 *   node scripts/stage-h3.mjs --bump
 *   node scripts/stage-h3.mjs --version 1.0.0
 *
 * 上传到: http://mt-agent.com/mtnode/h3/
 *   - manifest.json
 *   - h3-runtime-<ver>.zip
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PACK = path.join(ROOT, "h3-pack");
const OUT = path.join(ROOT, "dist", "h3-publish");
const MAN_PATH = path.join(PACK, "manifest.json");
const CATALOG_PATH = path.join(ROOT, "plugins", "catalog.default.json");
const PLUGIN_ID = "minimax-h3";

function readJson(file) {
  let text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function bumpPatch(ver) {
  const m = String(ver || "0.0.0").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error("非法 H3 版本号: " + ver + "（应为 x.y.z）");
  return m[1] + "." + m[2] + "." + (parseInt(m[3], 10) + 1);
}

function applyVersion(ver) {
  const man = readJson(MAN_PATH);
  man.version = ver;
  man.zipUrl = `h3-runtime-${ver}.zip`;
  writeJson(MAN_PATH, man);

  if (fs.existsSync(CATALOG_PATH)) {
    const cat = readJson(CATALOG_PATH);
    const plugins = Array.isArray(cat.plugins) ? cat.plugins : [];
    let touched = false;
    for (const p of plugins) {
      if (!p) continue;
      if (p.id === PLUGIN_ID || p.handler === "h3" || p.kind === "h3") {
        if (p.version !== ver) {
          p.version = ver;
          touched = true;
        }
      }
    }
    if (touched) {
      cat.updatedAt = new Date().toISOString();
      writeJson(CATALOG_PATH, cat);
    }
  }
  return man;
}

function main() {
  if (!fs.existsSync(path.join(PACK, "manifest.json"))) {
    throw new Error("缺少 h3-pack/manifest.json");
  }
  if (!fs.existsSync(path.join(PACK, "app", "pipeline.py"))) {
    throw new Error("缺少 h3-pack/app/pipeline.py");
  }

  const verFlag = process.argv.indexOf("--version");
  const doBump = process.argv.includes("--bump");
  let man = readJson(MAN_PATH);
  let ver = String(man.version || "0.1.0");
  if (verFlag >= 0) {
    const next = String(process.argv[verFlag + 1] || "").trim();
    if (!/^\d+\.\d+\.\d+$/.test(next)) {
      throw new Error("--version 需要 x.y.z，收到: " + next);
    }
    const prev = ver;
    ver = next;
    man = applyVersion(ver);
    console.log(`[stage-h3] version set ${prev} → ${ver}`);
  } else if (doBump) {
    const prev = ver;
    ver = bumpPatch(prev);
    man = applyVersion(ver);
    console.log(`[stage-h3] version bump ${prev} → ${ver}`);
  }
  const zipName = `h3-runtime-${ver}.zip`;

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const zipPath = path.join(OUT, zipName);
  const staging = path.join(OUT, "_stage");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const skip = new Set(["node_modules", "models", ".venv", "__pycache__", "ComfyUI"]);
  for (const name of fs.readdirSync(PACK)) {
    if (skip.has(name)) continue;
    if (name.startsWith(".") && name !== ".gitignore") continue;
    fs.cpSync(path.join(PACK, name), path.join(staging, name), { recursive: true });
  }
  if (process.platform === "win32") {
    const ps = `Compress-Archive -Path '${staging.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-r", zipPath, "."], { cwd: staging, stdio: "inherit" });
  }
  fs.rmSync(staging, { recursive: true, force: true });

  const buf = fs.readFileSync(zipPath);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const outMan = {
    ...man,
    version: ver,
    zipUrl: zipName,
    sha256: hash,
    bytes: buf.length,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(outMan, null, 2), "utf8");
  fs.writeFileSync(
    path.join(OUT, "README.txt"),
    [
      `MTNode Minimax H3 scaffold v${ver}`,
      `Upload this folder to http://mt-agent.com/mtnode/h3/`,
      `Files: manifest.json, ${zipName}`,
      `sha256: ${hash}`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`[stage-h3] v${ver} → ${OUT}`);
  console.log(`  + ${zipName}  (${(buf.length / 1024).toFixed(1)} KB)`);
  console.log(`  + manifest.json  sha256=${hash.slice(0, 12)}…`);
}

main();

/**
 * 打包可选桌宠运行时到 dist/pet-publish/（不随主程序 NSIS 安装包分发）。
 *
 * 用法:
 *   node scripts/stage-pet.mjs                # 使用 pet-pack/manifest.json 当前版本
 *   node scripts/stage-pet.mjs --bump         # 末位 +1 后打包（release-pet 默认）
 *   node scripts/stage-pet.mjs --version 1.0.0  # 指定版本后打包
 *
 * 上传到: http://mt-agent.com/mtnode/pet/
 *   - manifest.json
 *   - pet-runtime-<ver>.zip
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PACK = path.join(ROOT, "pet-pack");
const OUT = path.join(ROOT, "dist", "pet-publish");
const MAN_PATH = path.join(PACK, "manifest.json");
const CATALOG_PATH = path.join(ROOT, "plugins", "catalog.default.json");

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
  if (!m) throw new Error("非法桌宠版本号: " + ver + "（应为 x.y.z）");
  return m[1] + "." + m[2] + "." + (parseInt(m[3], 10) + 1);
}

/** 写回 pet-pack/manifest.json，并同步插件目录里的 bongochat 版本 */
function applyPetVersion(ver) {
  const man = readJson(MAN_PATH);
  man.version = ver;
  man.zipUrl = `pet-runtime-${ver}.zip`;
  writeJson(MAN_PATH, man);

  if (fs.existsSync(CATALOG_PATH)) {
    const cat = readJson(CATALOG_PATH);
    const plugins = Array.isArray(cat.plugins) ? cat.plugins : [];
    let touched = false;
    for (const p of plugins) {
      if (!p) continue;
      if (p.id === "bongochat" || p.handler === "pet" || p.kind === "pet") {
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
  if (!fs.existsSync(path.join(PACK, "index.html"))) {
    throw new Error("缺少 pet-pack/index.html");
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
    man = applyPetVersion(ver);
    console.log(`[stage-pet] version set ${prev} → ${ver}`);
  } else if (doBump) {
    const prev = ver;
    ver = bumpPatch(prev);
    man = applyPetVersion(ver);
    console.log(`[stage-pet] version bump ${prev} → ${ver}`);
  }
  const zipName = `pet-runtime-${ver}.zip`;

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const zipPath = path.join(OUT, zipName);
  /* 排除开发依赖，只打运行时需要的文件 */
  const staging = path.join(OUT, "_stage");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const skip = new Set(["node_modules", "package.json", "package-lock.json", "live2d-boot.mjs"]);
  for (const name of fs.readdirSync(PACK)) {
    if (skip.has(name)) continue;
    if (name.startsWith(".")) continue;
    fs.cpSync(path.join(PACK, name), path.join(staging, name), { recursive: true });
  }
  if (process.platform === "win32") {
    const ps = [
      `Compress-Archive -Path '${staging.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ].join(" ");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", ps],
      { stdio: "inherit" },
    );
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
  fs.writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify(outMan, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(OUT, "README.txt"),
    [
      `MTNode desktop pet runtime v${ver}`,
      `Upload this folder to http://mt-agent.com/mtnode/pet/`,
      `Files: manifest.json, ${zipName}`,
      `sha256: ${hash}`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`[stage-pet] v${ver} → ${OUT}`);
  console.log(`  + ${zipName}  (${(buf.length / 1024).toFixed(1)} KB)`);
  console.log(`  + manifest.json  sha256=${hash.slice(0, 12)}…`);
}

main();

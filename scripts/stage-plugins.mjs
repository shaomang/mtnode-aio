/**
 * 发布应用插件目录到 dist/plugins-publish/（上传到 http://mt-agent.com/mtnode/plugins/）。
 *
 * 用法:
 *   node scripts/stage-plugins.mjs
 *
 * 说明（重要）:
 *   MTNode 讨论区（forum）自 1.1.28 起已是**应用原生自带**（源码随包，见 build.json 的 "forum/**"），
 *   不再作为可下载插件发布：plugins/catalog.default.json 里已无 id=forum 条目，
 *   本脚本也不再产出 forum-*.zip。目录里仍有 kind=window 且在本脚本 PACKS 登记了源码的插件时，
 *   照旧打包并回写指纹。
 *
 * 上传（需人工执行）:
 *   - catalog.json
 *   - 各 window 插件的 zip（文件名与 catalog 里 zipUrl 一致）
 *   - 插件图标 png
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "plugins", "catalog.default.json");
const OUT = path.join(ROOT, "dist", "plugins-publish");

/**
 * 需要「从源码打包成 zip」的 window 插件登记表：id → 源文件列表。
 * 讨论区原生化后已从目录移除，这里不再登记 forum（其源码随安装包分发，不参与插件发布）。
 */
const PACKS = {};

function readJson(file) {
  let text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function zipFiles(filePaths, zipPath) {
  const staging = path.join(OUT, "_stage_" + path.basename(zipPath, ".zip"));
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) throw new Error("缺少 " + fp);
    fs.copyFileSync(fp, path.join(staging, path.basename(fp)));
  }
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  if (process.platform === "win32") {
    const ps = `Compress-Archive -Path '${staging.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-r", zipPath, "."], { cwd: staging, stdio: "inherit" });
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error("缺少 " + SRC);

  /* 原 forum 专属的 --bump / --version 随原生化一并退场：不再有可发布的讨论区插件包。 */
  if (process.argv.includes("--bump") || process.argv.indexOf("--version") >= 0) {
    throw new Error(
      "讨论区已改为应用原生自带（随包分发），不再参与插件发布，" +
        "--bump / --version 已无意义；直接运行 node scripts/stage-plugins.mjs 即可。",
    );
  }

  const doc = readJson(SRC);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const plugins = Array.isArray(doc.plugins) ? doc.plugins : [];
  for (const p of plugins) {
    if (!p || p.kind !== "window") continue;
    const pack = PACKS[p.id];
    if (!pack) continue;
    const zipName = String(p.zipUrl || p.id + "-" + (p.version || "0.0.0") + ".zip").replace(/^.*\//, "");
    const zipPath = path.join(OUT, zipName);
    zipFiles(pack.files, zipPath);
    const buf = fs.readFileSync(zipPath);
    p.zipUrl = zipName;
    p.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    p.bytes = buf.length;
    console.log("zip", zipName, buf.length, "sha256", p.sha256);
  }

  const iconDir = path.join(ROOT, "plugins", "icons");
  if (fs.existsSync(iconDir)) {
    for (const name of fs.readdirSync(iconDir)) {
      if (!/\.(png|jpe?g|webp)$/i.test(name)) continue;
      fs.copyFileSync(path.join(iconDir, name), path.join(OUT, name));
      console.log("icon", name);
    }
  }

  doc.updatedAt = new Date().toISOString();
  writeJson(SRC, doc);
  const dest = path.join(OUT, "catalog.json");
  writeJson(dest, doc);
  fs.writeFileSync(
    path.join(OUT, "README.txt"),
    [
      "Upload to http://mt-agent.com/mtnode/plugins/",
      "  catalog.json",
      "  *.zip",
      "  *.png (plugin grid icons, 128x128)",
      "",
      "note: MTNode 讨论区 (forum) 已是应用原生自带，不再作为插件包发布。",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log("wrote", dest);
  console.log("plugins:", plugins.length);
  console.log("upload to: http://mt-agent.com/mtnode/plugins/catalog.json");
}

main();

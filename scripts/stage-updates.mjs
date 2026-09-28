/**
 * 将 electron-builder 产物整理为可上传到云服务器的更新目录。
 *
 * 用法（先对齐 version / package.json，再 npm run dist）:
 *   npm run dist
 *   npm run release:stage
 *
 * 输出: dist/updates-publish/
 *   - latest.yml
 *   - MTNodeAIO-Setup-<ver>.exe
 *   - MTNodeAIO-Setup-<ver>.exe.blockmap   ← 差分下载用
 *
 * 上传示例见 scripts/UPDATES.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(DIST, "updates-publish");

function versionFromLatestYml() {
  const latest = path.join(DIST, "latest.yml");
  if (!fs.existsSync(latest)) return null;
  const raw = fs.readFileSync(latest, "utf8");
  const m = raw.match(/^version:\s*[\"']?([0-9]+\.[0-9]+\.[0-9]+)/m);
  return m ? m[1] : null;
}

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`缺少 ${label}: ${p}\n请先执行: npm run dist`);
  }
}

function main() {
  const latestPath = path.join(DIST, "latest.yml");
  mustExist(latestPath, "latest.yml");

  const ver =
    versionFromLatestYml() ||
    JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const vf = fs.readFileSync(path.join(ROOT, "version"), "utf8").trim();
  if (vf !== ver) {
    console.warn(
      `[stage-updates] 警告: version 文件(${vf}) 与构建产物(${ver}) 不一致，请发版前对齐`,
    );
  }

  const setup = path.join(DIST, `MTNodeAIO-Setup-${ver}.exe`);
  const blockmap = setup + ".blockmap";
  mustExist(setup, "安装包");
  if (!fs.existsSync(blockmap)) {
    console.warn(
      "[stage-updates] 未找到 .blockmap — 差分更新将不可用，客户端会整包下载",
    );
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const copy = (src, name) => {
    if (!fs.existsSync(src)) return false;
    fs.copyFileSync(src, path.join(OUT, name));
    const st = fs.statSync(src);
    console.log(`  + ${name}  (${(st.size / 1024 / 1024).toFixed(2)} MB)`);
    return true;
  };

  console.log(`[stage-updates] v${ver} → ${OUT}`);
  copy(latestPath, "latest.yml");
  copy(setup, path.basename(setup));
  copy(blockmap, path.basename(blockmap));

  const notes = [
    `# MTNode AIO 更新通道 v${ver}`,
    ``,
    `发布时间: ${new Date().toISOString()}`,
    `更新源 URL: http://mt-agent.com/mtnode/updates/`,
    ``,
    `文件:`,
    `- latest.yml — electron-updater 清单`,
    `- MTNodeAIO-Setup-${ver}.exe — 完整安装包`,
    `- MTNodeAIO-Setup-${ver}.exe.blockmap — 差分块图（已装旧版时只下变更块）`,
    ``,
    `nginx 需提供 /mtnode/updates/ 静态目录，并支持 HTTP Range（差分必需）。`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "README.txt"), notes, "utf8");

  console.log("");
  console.log("上传到服务器（示例）:");
  console.log(
    `  rsync -avz --delete "${OUT}/" user@YOUR_HOST:/var/www/html/mtnode/updates/`,
  );
}

main();

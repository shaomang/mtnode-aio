/**
 * Patch dist/win-unpacked app.asar with current pet main/preload sources.
 * Usage: node scripts/patch-pet-asar.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ASAR = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");
const TMP = path.join(ROOT, "dist", "_asar_patch_tmp");
const OUT = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar.new");

const FILES = [
  ["pet/standalone-main.js", path.join(ROOT, "pet", "standalone-main.js")],
  ["pet/preload-pet.js", path.join(ROOT, "pet", "preload-pet.js")],
  ["pet/main-pet.js", path.join(ROOT, "pet", "main-pet.js")],
  ["pet/chat-ui/chat.html", path.join(ROOT, "pet", "chat-ui", "chat.html")],
  ["pet/chat-ui/chat.js", path.join(ROOT, "pet", "chat-ui", "chat.js")],
];

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

async function main() {
  if (!fs.existsSync(ASAR)) {
    throw new Error("missing " + ASAR);
  }
  rm(TMP);
  rm(OUT);
  fs.mkdirSync(TMP, { recursive: true });
  console.log("[patch-pet-asar] extract…");
  asar.extractAll(ASAR, TMP);
  for (const [rel, src] of FILES) {
    if (!fs.existsSync(src)) throw new Error("missing source " + src);
    const dest = path.join(TMP, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log("  +", rel);
  }
  console.log("[patch-pet-asar] pack…");
  await asar.createPackage(TMP, OUT);
  const bak = ASAR + ".bak";
  try {
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
    fs.renameSync(ASAR, bak);
    fs.renameSync(OUT, ASAR);
  } catch (err) {
    if (err && err.code === "EBUSY") {
      try {
        fs.copyFileSync(OUT, ASAR);
        try {
          fs.unlinkSync(OUT);
        } catch {}
        console.log("[patch-pet-asar] asar was locked; overwrote in place");
      } catch (err2) {
        console.error(
          "[patch-pet-asar] asar locked. Close MTNode/BongoChat, then rename:\n  " +
            OUT +
            "\n→ " +
            ASAR,
        );
        throw err2;
      }
    } else {
      throw err;
    }
  }
  rm(TMP);

  const runtimeApp = path.join(
    process.env.APPDATA || "",
    "pipeline-console",
    "pipeline-console",
    "pet",
    "runtime",
    "app.js",
  );
  const packApp = path.join(ROOT, "pet-pack", "app.js");
  if (fs.existsSync(runtimeApp) && fs.existsSync(packApp)) {
    fs.copyFileSync(packApp, runtimeApp);
    console.log("  synced user runtime app.js");
  }
  const runtimeDir = path.join(
    process.env.APPDATA || "",
    "pipeline-console",
    "pipeline-console",
    "pet",
    "runtime",
  );
  const chatFiles = ["chat.js", "chat.html"];
  for (const name of chatFiles) {
    const src = path.join(ROOT, "pet", "chat-ui", name);
    const dest = path.join(runtimeDir, name);
    if (fs.existsSync(src) && fs.existsSync(runtimeDir)) {
      fs.copyFileSync(src, dest);
      console.log("  synced user runtime", name);
    }
    const packDest = path.join(ROOT, "pet-pack", name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, packDest);
    }
  }
  const srcPreload = path.join(ROOT, "pet", "preload-pet.js");
  if (fs.existsSync(srcPreload)) {
    fs.copyFileSync(srcPreload, path.join(ROOT, "pet-pack", "preload-pet.js"));
  }
  const userPreload = path.join(
    process.env.APPDATA || "",
    "pipeline-console",
    "pipeline-console",
    "pet",
    "preload-pet.js",
  );
  if (fs.existsSync(path.dirname(userPreload)) && fs.existsSync(srcPreload)) {
    fs.copyFileSync(srcPreload, userPreload);
    console.log("  synced user pet preload-pet.js");
  }
  console.log("[patch-pet-asar] done →", ASAR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

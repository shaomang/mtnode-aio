/* 迁移脚本的现场冒烟（临时工具：造一份假数据目录，真跑迁移并验幂等；跑完即删）
 * 用法：node tools/check-migrate-app-family.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(".");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-migrate-"));
const DATA = path.join(TMP, "data");
const WEB = path.join(TMP, "web");
fs.mkdirSync(path.join(DATA, "apps"), { recursive: true });
fs.mkdirSync(path.join(DATA, "app-icons"), { recursive: true });
fs.mkdirSync(WEB, { recursive: true });

const now = Date.now();
const db = {
  users: [
    { id: "u_a", username: "author-a", nickname: "甲" },
    { id: "u_b", username: "author-b", nickname: "乙" },
  ],
  apps: [
    /* 源应用（原创） */
    { id: "demo", userId: "u_a", title: "原应用", version: "1.0.0", latestVersion: "1.0.0", createdAt: now - 3000, updatedAt: now - 3000, versions: [{ version: "1.0.0", createdAt: now - 3000 }] },
    /* 老形态：另一个 id + forkOf 指回 demo */
    { id: "demo-fork", userId: "u_b", title: "别人的二次开发", version: "2.0.0", latestVersion: "2.0.0", createdAt: now - 2000, updatedAt: now - 2000, forkOf: { id: "demo", ownerId: "u_a" }, versions: [{ version: "2.0.0", createdAt: now - 2000 }] },
  ],
};
fs.writeFileSync(path.join(DATA, "db.json"), JSON.stringify(db, null, 2), "utf8");
/* 老路径的包与图标 */
fs.writeFileSync(path.join(DATA, "apps", "demo-fork__u_b.zip"), "zip-b", "utf8");
fs.mkdirSync(path.join(DATA, "apps", "demo-fork", "u_b"), { recursive: true });
fs.writeFileSync(path.join(DATA, "apps", "demo-fork", "u_b", "2.0.0.zip"), "zip-b-v2", "utf8");
fs.writeFileSync(path.join(DATA, "app-icons", "demo-fork__u_b.png"), "png-b", "utf8");

function run(extra) {
  return spawnSync(process.execPath, [path.join("store-saas", "migrate-app-family.mjs"), "--data", DATA, "--web", WEB].concat(extra || []), {
    cwd: ROOT,
    encoding: "utf8",
  });
}
let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ " + label);
  }
};

const dry = run(["--dry-run"]);
ok(
  dry.status === 0 && /demo-fork/.test(dry.stdout) &&
    fs.readdirSync(TMP).every((n) => !n.startsWith("data-backup-migrate-")),
  "dry-run 只报告不落盘（也不备份）",
);
const after = JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
ok(after.apps.find((a) => a.id === "demo-fork"), "dry-run 后 db.json 未被改");

const r1 = run([]);
ok(r1.status === 0, "真跑成功（退出码 0）：" + (r1.stdout || "") + (r1.stderr || ""));
const db1 = JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
ok(db1.apps.some((a) => a.id === "demo" && a.userId === "u_b"), "老条目已改成同 id（demo + u_b）");
ok(!db1.apps.some((a) => a.id === "demo-fork"), "旧 id 不再存在");
const moved = db1.apps.find((a) => a.id === "demo" && a.userId === "u_b");
ok(moved && moved.forkOf && moved.forkOf.id === "demo" && moved.forkOf.ownerId === "u_a", "forkOf 原样保留（父子关系与根判定靠它）");
ok(fs.existsSync(path.join(DATA, "apps", "demo__u_b.zip")), "镜像包搬到新名字（<id>__<uid>.zip）");
ok(fs.existsSync(path.join(DATA, "apps", "demo", "u_b", "2.0.0.zip")), "版本包搬到新目录（<id>/<uid>/<版本>.zip）");
ok(fs.existsSync(path.join(DATA, "app-icons", "demo__u_b.png")), "图标搬到新名字");
ok(!fs.existsSync(path.join(DATA, "apps", "demo-fork__u_b.zip")) && !fs.existsSync(path.join(DATA, "apps", "demo-fork")), "老文件已清掉（不留双份）");
const backups = fs.readdirSync(TMP).filter((n) => n.startsWith("data-backup-migrate-"));
ok(backups.length === 1, "真改前备份了一次（" + backups.join(",") + "）");
ok(fs.existsSync(path.join(WEB, "catalog.json")), "静态目录已重算");

const r2 = run([]);
ok(r2.status === 0 && /没有需要迁移的条目/.test(r2.stdout), "重复跑幂等（第二次无事可做）");
const db2 = JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
ok(db2.apps.length === db1.apps.length, "幂等：条目数不变");
ok(fs.readdirSync(TMP).filter((n) => n.startsWith("data-backup-migrate-")).length === 1, "幂等：没有再备份一次");

console.log("\n" + (fail ? "FAILED " + fail : "ALL PASS " + pass) + " 项");
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);

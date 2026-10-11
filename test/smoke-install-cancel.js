"use strict";
/**
 * 安装中断（真进程）回归 —— 本模块「插件安装时无法中断」的唯一硬证据。
 *
 * 为什么必须真拉进程：历史上 8 个宿主的取消口只做 `installCancel = true`，标志要等
 * powershell 脚本**自己跑完**才被 `child.on("close")` 读到 —— 静态断言（「有没有置标志」）
 * 即使全绿，用户点「取消安装」在下载 / 装 torch 期间照样毫无反应。所以这里真起一条
 * powershell → node 的进程树，调取消，断言它在数秒内从进程表里消失。
 *
 * 口径：
 *   [1] track/untrack/activePidOf 的登记语义（含重复 track 覆盖旧的）；
 *   [2] killTree 真杀：parent 与其子进程都不在进程表里（win32 走 taskkill /T /F）；
 *   [3] cancelInstall 走同一条路；没登记的插件返回 noop（不算失败）；
 *   [4] taskkill 的命令行形态（`cmd.exe /d /s /c taskkill /PID n /T /F`）—— 直接
 *       execFile("taskkill", ["/T"]) 会被 taskkill 当成 TTY 开关而在 win32 上失败；
 *   [5] 状态机：取消后快照落 state="cancelled"，「已取消」不当安装失败，安装窗还留着重试按钮。
 * 跑法：node test/smoke-install-cancel.js
 */
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const installKill = require(path.join(ROOT, "plugins/install-cancel.js"));
const steps = require(path.join(ROOT, "plugins/install-steps.js"));

let checks = 0;
let fails = 0;
function ok(cond, label) {
  checks++;
  if (cond) console.log("  ok   " + label);
  else {
    fails++;
    console.log("  FAIL " + label);
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function alive(pid) {
  if (!pid) return false;
  const r = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", "tasklist /FI \"PID eq " + Number(pid) + "\" /NH"],
    { encoding: "utf8", windowsHide: true },
  );
  return new RegExp("\\b" + Number(pid) + "\\b").test(String(r.stdout || ""));
}

/** 起一条 powershell → node 的进程树（模拟 install.ps1 拉起 pip / python 的样子）。 */
function spawnInstallTree() {
  const code = 'node -e "setTimeout(()=>{}, 60000)"';
  const enc = Buffer.from(code, "utf16le").toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
    { windowsHide: true, stdio: "ignore" },
  );
  return child;
}

/** 该 powershell 直接拉起的子进程 pid（node）。 */
function childrenOf(pid) {
  const r = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", "wmic process where (ParentProcessId=" + Number(pid) + ") get ProcessId /value"],
    { encoding: "utf8", windowsHide: true },
  );
  const out = String(r.stdout || "");
  const pids = [];
  const re = /ProcessId=(\d+)/g;
  let m;
  while ((m = re.exec(out))) pids.push(Number(m[1]));
  return pids;
}

function makeSnap() {
  return steps.createSnapshot({
    id: "smoke-host",
    name: "冒烟插件",
    installDir: "C:\\tmp\\smoke-install",
    steps: [
      { id: "prepare", title: "准备目录" },
      { id: "download", title: "下载权重" },
      { id: "venv", title: "安装依赖" },
      { id: "done", title: "写入安装信息" },
    ],
  });
}

async function main() {
  console.log("[1] 登记语义：track / activePidOf / untrack（含重复 track 覆盖）");
  const idA = "smoke-plugin-a";
  ok(installKill.activePidOf(idA) === 0, "未登记时 activePidOf=0");
  const c1 = spawnInstallTree();
  await sleep(600);
  installKill.track(idA, c1);
  ok(installKill.activePidOf(idA) === c1.pid, "track 之后按 pluginId 取回同一个 pid");
  const c2 = spawnInstallTree();
  await sleep(600);
  installKill.track(idA, c2);
  ok(installKill.activePidOf(idA) === c2.pid, "重复 track（重试 / 重装）覆盖为最新那个进程");
  installKill.untrack(idA);
  ok(installKill.activePidOf(idA) === 0, "untrack 之后不再登记（装完不会被误杀）");
  await installKill.killTree(c1.pid, { child: c1 });
  await installKill.killTree(c2.pid, { child: c2 });

  console.log("\n[2] killTree 真杀进程树：powershell 与它拉起的 node 都要消失");
  const idB = "smoke-plugin-b";
  const child = spawnInstallTree();
  await sleep(1200);
  installKill.track(idB, child);
  const kids = childrenOf(child.pid);
  ok(!child.killed, "拉起后父进程还活着（断言没空转）");
  ok(kids.length >= 1, "powershell 真的拉起了子进程（" + kids.length + " 个：模拟 pip / python）");
  const t0 = Date.now();
  const r = await installKill.killTree(child.pid, { child });
  const ms = Date.now() - t0;
  await sleep(400);
  ok(r.ok === true && r.via === "taskkill", "win32 走 taskkill（via=" + r.via + "）");
  ok(!alive(child.pid), "父进程 powershell 已从进程表消失");
  const left = kids.filter((p) => alive(p));
  ok(left.length === 0, "子进程一并被带走（残留 " + left.length + " 个）");
  ok(ms < 6000, "数秒内完成（实测 " + ms + "ms）");

  console.log("\n[3] cancelInstall：登记过的按树杀，没登记的 noop（不算失败）");
  const idC = "smoke-plugin-c";
  const c3 = spawnInstallTree();
  await sleep(800);
  installKill.track(idC, c3);
  const rc = await installKill.cancelInstall(idC);
  const rAgain = await installKill.cancelInstall(idC);
  await sleep(300);
  ok(rc.ok === true && rc.noop === false, "取消回执 ok 且不是 noop");
  ok(rc.pid === c3.pid, "取消杀的就是登记的那个 pid");
  ok(rAgain.ok === true && rAgain.alreadyCancelling === true, "同一插件重复点取消 = alreadyCancelling（幂等，不重复 taskkill）");
  ok(!alive(c3.pid), "取消之后进程真的没了");
  installKill.untrack(idC);
  const r2 = await installKill.cancelInstall(idC);
  ok(r2.ok === true && r2.noop === true, "进程结束后已注销（close 回调 untrack）→ 再取消 = noop，不报错");
  const r3 = await installKill.cancelInstall("smoke-never-started");
  ok(r3.ok === true && r3.noop === true, "从没登记过的插件取消 = noop（调用方照常落终局）");

  console.log("\n[4] taskkill 形态：win32 走 cmd.exe 转发（直接 execFile 会把 /T 当 TTY 开关）");
  const src = require("fs").readFileSync(path.join(ROOT, "plugins/install-cancel.js"), "utf8");
  ok(src.indexOf('"cmd.exe"') >= 0, "win32 分支用 cmd.exe");
  ok(src.indexOf("/d") >= 0 && src.indexOf("/s") >= 0 && src.indexOf("/c") >= 0, "cmd.exe 带 /d /s /c（引号不丢）");
  ok(/taskkill \/PID \$\{n\} \/T \/F/.test(src), "命令行是 taskkill /PID <pid> /T /F（按进程树强杀）");
  const bogus = await installKill.killTree(999999);
  ok(bogus.ok === true && bogus.gone === true, "pid 不存在时也返回结构化回执（不抛）");

  console.log("\n[5] 状态机：取消落 state=cancelled（不是 failed），安装窗仍给「重试」");
  const snap = makeSnap();
  steps.applyStep(snap, { id: "prepare", status: "ok" });
  steps.applyStep(snap, { id: "download", status: "run" });
  ok(snap.state === "running", "脚本打了步骤行 → running");
  steps.finishSnapshot(snap, { ok: false, cancelled: true, error: "cancelled" });
  ok(snap.state === "cancelled", "取消后 state=cancelled");
  ok(snap.state !== "failed", "不再把「用户主动终止」当安装失败");
  ok(snap.steps[1].status === "fail", "正在跑的那一步停在 fail（看清死在哪一步）");
  ok(snap.steps[2].status === "skip" && snap.steps[3].status === "skip", "没跑到的步骤标 skip");
  const uiSrc = require("fs").readFileSync(path.join(ROOT, "install/app.js"), "utf8");
  ok(uiSrc.indexOf('snap.state === "cancelled"') >= 0, "安装窗按 cancelled 单独渲染（不落进失败文案）");
  ok(uiSrc.indexOf("已取消（你主动终止）") >= 0, "标题写「已取消（你主动终止）」");
  ok(
    /snap\.state === "failed" \|\| snap\.state === "cancelled"[\s\S]{0,120}?重试/.test(uiSrc),
    "取消后仍保留「重试」入口（重试＝脚本续跑）",
  );
  const hostSrc = require("fs").readFileSync(path.join(ROOT, "plugins/main-install.js"), "utf8");
  ok(
    /cancelInstall[\s\S]{0,1600}?finishSnapshot\(snap, \{ ok: false, cancelled: true/.test(hostSrc),
    "编排层在取消口返回后落取消终局（宿主不用各自再写一遍）",
  );

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke crash: " + String((e && e.stack) || e));
  process.exit(1);
});

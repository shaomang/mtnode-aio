"use strict";
/* 本机微信 PC 版检测与启动（纯主进程、零新依赖）。
 *
 * 边界（刻意不做的事）：
 *   - 不做任何注入 / hook；
 *   - 不读取微信本地数据（聊天记录 / 数据库 / 文件）；
 *   - 不联网。
 * 只做两件事：detect() 找到本机微信 exe 与运行状态；launch() 置前或拉起。
 */

const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

const PS = "powershell.exe";
const PROBE_TIMEOUT = 8000;

/* ── 低层命令封装：一律失败静默，返回空串 ─────────────────────────── */

function psRun(script, timeout) {
  return new Promise((resolve) => {
    execFile(
      PS,
      ["-NoProfile", "-NonInteractive", "-Command", String(script || "")],
      { windowsHide: true, timeout: timeout || PROBE_TIMEOUT, encoding: "utf8" },
      (err, stdout) => resolve(err ? "" : String(stdout || "")),
    );
  });
}

function regQuery(args, timeout) {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query"].concat(args || []),
      { windowsHide: true, timeout: timeout || 5000, encoding: "utf8" },
      (err, stdout) => resolve(err ? "" : String(stdout || "")),
    );
  });
}

function parseRegValue(out, name) {
  const re = new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+REG_[A-Z_]+\\s+(.+)", "i");
  const m = String(out || "").match(re);
  return m ? m[1].trim() : "";
}

function stripQuotes(s) {
  return String(s == null ? "" : s).trim().replace(/^"+/, "").replace(/"+$/, "").trim();
}

function validExe(p) {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function exeFromDir(dir, kind) {
  const d = stripQuotes(dir);
  if (!d) return "";
  if (/\.exe$/i.test(d)) return d;
  return path.join(d, kind === "weixin" ? "Weixin.exe" : "WeChat.exe");
}

/* ── 探测源 ①：注册表 InstallPath（HKCU / HKLM，含 WOW6432Node）──── */

const REG_KEYS = [
  { path: "HKCU\\Software\\Tencent\\WeChat", kind: "wechat" },
  { path: "HKLM\\Software\\Tencent\\WeChat", kind: "wechat" },
  { path: "HKLM\\Software\\WOW6432Node\\Tencent\\WeChat", kind: "wechat" },
  { path: "HKCU\\Software\\Tencent\\Weixin", kind: "weixin" },
  { path: "HKLM\\Software\\Tencent\\Weixin", kind: "weixin" },
  { path: "HKLM\\Software\\WOW6432Node\\Tencent\\Weixin", kind: "weixin" },
];

/* ── 探测源 ②：卸载表 DisplayName 匹配 微信 | WeChat | Weixin ──────── */

const UNINSTALL_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$roots=@(",
  "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
  "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
  "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall');",
  "foreach($r in $roots){",
  "  Get-ChildItem $r -ErrorAction SilentlyContinue | ForEach-Object {",
  "    $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue;",
  "    if($p.DisplayName -match '微信|WeChat|Weixin'){",
  "      Write-Output ($p.DisplayName + '|' + $p.InstallLocation + '|' + $p.DisplayVersion)",
  "    }",
  "  }",
  "}",
].join(" ");

/* ── 探测源 ③：常见安装路径 ──────────────────────────────────────── */

function commonCandidates() {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const list = [];
  for (const root of [pf, pf86]) {
    list.push({ exe: path.join(root, "Tencent", "WeChat", "WeChat.exe"), kind: "wechat" });
    list.push({ exe: path.join(root, "Tencent", "Weixin", "Weixin.exe"), kind: "weixin" });
  }
  return list;
}

/* ── 运行状态 / 版本 ────────────────────────────────────────────── */

async function isRunning() {
  const out = await psRun(
    "(Get-Process -Name WeChat,Weixin -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty ProcessName)",
  );
  const s = out.trim().toLowerCase();
  return s === "wechat" || s === "weixin";
}

async function exeVersion(exe) {
  if (!exe) return "";
  const lit = String(exe).replace(/'/g, "''");
  const out = await psRun(
    "(Get-Item -LiteralPath '" + lit + "' -ErrorAction SilentlyContinue).VersionInfo.FileVersion",
  );
  return out.trim();
}

/* ── detect ─────────────────────────────────────────────────────── */

async function detect() {
  const running = await isRunning();
  let exe = "";
  let kind = "";
  let version = "";

  /* ① 注册表 */
  for (const key of REG_KEYS) {
    const out = await regQuery([key.path]);
    if (!out) continue;
    const dir = parseRegValue(out, "InstallPath");
    if (!dir) continue;
    const cand = exeFromDir(dir, key.kind);
    if (validExe(cand)) {
      exe = cand;
      kind = key.kind;
      version = parseRegValue(out, "Version");
      break;
    }
  }

  /* ② 卸载表 */
  if (!exe) {
    const out = await psRun(UNINSTALL_SCRIPT);
    for (const line of out.split(/\r?\n/)) {
      const parts = line.split("|");
      if (parts.length < 2) continue;
      const dir = stripQuotes(parts[1]);
      if (!dir) continue;
      const k = /weixin/i.test(dir) ? "weixin" : "wechat";
      const cand = exeFromDir(dir, k);
      if (validExe(cand)) {
        exe = cand;
        kind = k;
        version = String(parts[2] || "").trim();
        break;
      }
    }
  }

  /* ③ 常见路径 */
  if (!exe) {
    for (const c of commonCandidates()) {
      if (validExe(c.exe)) {
        exe = c.exe;
        kind = c.kind;
        break;
      }
    }
  }

  if (exe && !version) version = await exeVersion(exe);

  return {
    installed: !!exe,
    exe: exe || "",
    kind: kind || "",
    version: version || "",
    running: !!running,
  };
}

/* ── launch ─────────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bringToFront(kind) {
  const titles = kind === "weixin" ? ["微信", "Weixin", "WeChat"] : ["微信", "WeChat", "Weixin"];
  const arr = titles.map((t) => "'" + String(t).replace(/'/g, "''") + "'").join(",");
  const script =
    "try{ $w=New-Object -ComObject WScript.Shell; " +
    "foreach($t in @(" + arr + ")){ if($w.AppActivate($t)){ Write-Output '1'; break } } }catch{}";
  const out = await psRun(script, 5000);
  return out.trim() === "1";
}

async function launch() {
  const info = await detect();
  if (!info.installed) {
    return { ok: false, launched: false, foreground: false, exe: "", error: "未检测到微信" };
  }

  if (info.running) {
    const foreground = await bringToFront(info.kind);
    return { ok: true, launched: false, foreground, exe: info.exe };
  }

  try {
    spawn(info.exe, [], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    return {
      ok: false,
      launched: false,
      foreground: false,
      exe: info.exe,
      error: String((e && e.message) || e || "启动失败"),
    };
  }

  /* 短暂轮询等待进程出现（最多约 10 秒） */
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await isRunning()) break;
  }

  const foreground = await bringToFront(info.kind);
  return { ok: true, launched: true, foreground, exe: info.exe };
}

module.exports = { detect, launch };

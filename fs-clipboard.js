"use strict";
/* ============================================================
 * 系统剪贴板 ↔ 文件列表（Windows CF_HDROP）的唯一口径
 *
 * 为什么不是 Electron 的 clipboard API：探针实测（Electron 39）——
 *   · 资源管理器 / PowerShell 写进去的 CF_HDROP，Electron 只把它映射成
 *     FileNameW / FileName 的**第一项**（第二个文件开始就没了），
 *     text/uri-list 又读不到字节；`clipboard.writeBuffer` 也写不出真正的
 *     CF_HDROP（Windows 资源管理器不认）。所以「批量互通」这条需求没法靠它。
 *   · 读写统一走 PowerShell + System.Windows.Forms（5.1 默认 STA）：
 *      写 = DataObject.SetFileDropList + Preferred DropEffect（1 复制 / 2 剪切）；
 *      读 = GetDataObject → FileDrop 全部条目 + Preferred DropEffect。
 *   代价是每次动作起一次子进程（约 0.2–0.5 秒），只在用户点复制/剪切/粘贴时发生。
 *
 * 编码：路径一律经 `-EncodedCommand`（UTF-16LE base64）传入，中文 / 空格 / 引号都安全；
 * 读回的结果由 PowerShell 写成 UTF-8 临时文件再取（stdout 会受控制台代码页影响）。
 *
 * 本模块只做「系统剪贴板 + 子进程」这两件事，文件校验 / 落盘由 main.js 负责；
 * 纯函数（解析 / 效果字节 / 脚本生成）可被 test/smoke-fs-clipboard.js 直接真跑。
 * ============================================================ */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

/* 一次最多往剪贴板里塞多少项（命令行长度与资源管理器实际承载都有上限） */
const FS_CLIP_MAX_ITEMS = 4096;
/* 子进程超时：剪贴板被别的进程占用时 PowerShell 会重试几次，给足余量 */
const FS_CLIP_TIMEOUT_MS = 20000;

/* CF_HDROP 的多文件分隔符是 \0；uri-list / 手写列表用换行 */
const FS_CLIP_SPLIT_RE = /[\u0000\r\n]+/;

/* 单个条目 → 绝对路径形态（去空白、去成对引号、file:/// 转本机路径） */
function fsClipNormEntry(raw) {
  const seg = String(raw == null ? "" : raw).trim().replace(/^"|"$/g, "");
  if (!seg || seg.charAt(0) === "#") return "";
  if (!/^file:\/\//i.test(seg)) return seg;
  let s = seg.replace(/^file:\/\//i, "");
  try {
    s = decodeURIComponent(s);
  } catch (_) {}
  if (/^localhost\//i.test(s)) s = s.slice("localhost/".length);
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  return s.replace(/\//g, path.sep);
}

/* 剪贴板里的文件列表串 → 路径数组（任意类型；保序去重，大小写不敏感） */
function fsClipParseList(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text == null ? "" : text).split(FS_CLIP_SPLIT_RE)) {
    const p = fsClipNormEntry(raw);
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/* Preferred DropEffect 的字节 → "copy" | "cut"（1 = 复制，2 = 移动/剪切） */
function fsClipEffectFromBytes(bytes) {
  const arr = bytes && typeof bytes.length === "number" ? bytes : [];
  if (arr.length < 4) return "copy";
  const v =
    (Number(arr[0]) & 255) |
    ((Number(arr[1]) & 255) << 8) |
    ((Number(arr[2]) & 255) << 16) |
    ((Number(arr[3]) & 255) << 24);
  return v === 2 ? "cut" : "copy";
}

/* JSON 解析要宽容：PowerShell 的 ConvertTo-Json 单项时会给对象而不是数组 */
function fsClipNormalizeRead(json) {
  const o = json && typeof json === "object" ? json : {};
  const raw = Array.isArray(o.paths) ? o.paths : o.paths ? [o.paths] : [];
  const paths = [];
  const seen = new Set();
  for (const x of raw) {
    const p = String(x == null ? "" : x).trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(p);
  }
  return { effect: String(o.effect || "").toLowerCase() === "cut" ? "cut" : "copy", paths };
}

/* PowerShell 单引号字符串字面量（内部的 ' 折半） */
function fsClipPsQuote(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'";
}

/* 写剪贴板脚本：FileDropList + Preferred DropEffect；被别的进程占用时重试几次 */
function fsClipBuildWriteScript(paths, mode) {
  const effect = String(mode) === "cut" ? 2 : 1;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    /* 重定向的 stderr 会混进 CLIXML 进度记录（"Preparing modules for first use."），
       关掉进度流，失败时报错才是人读得懂的原文 */
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.DataObject",
    "$c = New-Object System.Collections.Specialized.StringCollection",
  ];
  for (const p of paths || []) lines.push("[void]$c.Add(" + fsClipPsQuote(p) + ")");
  lines.push(
    "$d.SetFileDropList($c)",
    "$ms = New-Object System.IO.MemoryStream(,[byte[]](" + effect + ",0,0,0))",
    "$d.SetData('Preferred DropEffect',$ms)",
    "for ($i = 0; $i -lt 5; $i++) {",
    "  try { [System.Windows.Forms.Clipboard]::SetDataObject($d, $true); break }",
    "  catch { if ($i -eq 4) { throw }; Start-Sleep -Milliseconds 80 }",
    "}",
    "Write-Output 'ok'",
  );
  return lines.join("\r\n");
}

/* 读剪贴板脚本：FileDrop 全部条目 + Preferred DropEffect，写进 UTF-8 临时文件 */
function fsClipBuildReadScript(outFile) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$paths = @()",
    "$eff = 'copy'",
    "$o = $null",
    "for ($i = 0; $i -lt 5; $i++) {",
    "  try { $o = [System.Windows.Forms.Clipboard]::GetDataObject(); if ($o -ne $null) { break } }",
    "  catch { }",
    "  Start-Sleep -Milliseconds 80",
    "}",
    "if ($o -ne $null) {",
    "  try {",
    "    if ($o.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {",
    "      foreach ($x in @($o.GetData([System.Windows.Forms.DataFormats]::FileDrop))) {",
    "        if ($x -ne $null) { $paths += [string]$x }",
    "      }",
    "    }",
    "    $ms = $o.GetData('Preferred DropEffect')",
    "    if ($ms -ne $null -and $ms.Length -ge 4) {",
    "      $b = $ms.ToArray()",
    "      if ([BitConverter]::ToUInt32($b, 0) -eq 2) { $eff = 'cut' }",
    "    }",
    "  } catch { }",
    "}",
    "$json = [PSCustomObject]@{ effect = $eff; paths = @($paths) } | ConvertTo-Json -Compress -Depth 4",
    "[System.IO.File]::WriteAllText(" + fsClipPsQuote(outFile) + ", $json, (New-Object System.Text.UTF8Encoding $false))",
    "Write-Output 'ok'",
  ].join("\r\n");
}

/* powershell.exe 绝对路径（找不到就靠 PATH） */
function fsClipPwshExe() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const p = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  return "powershell.exe";
}

/* 跑一段 PowerShell：脚本走 -EncodedCommand（UTF-16LE），不落盘、不弹窗 */
function fsClipRunScript(script, deps) {
  const spawnFn = (deps && deps.spawn) || spawn;
  const exe = (deps && deps.exe) || fsClipPwshExe();
  const encoded = Buffer.from(String(script), "utf16le").toString("base64");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(
        exe,
        ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
      return;
    }
    let out = "";
    let errOut = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish({ ok: false, error: "PowerShell 超时" });
    }, FS_CLIP_TIMEOUT_MS);
    try {
      if (child.stdout) child.stdout.on("data", (b) => (out += String(b)));
      if (child.stderr) child.stderr.on("data", (b) => (errOut += String(b)));
    } catch (_) {}
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: String((err && err.message) || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true, stdout: out });
        return;
      }
      /* stderr 里常混 CLIXML 的进度/错误记录（`#< CLIXML …`）：只把能读的那句捞出来 */
      const clean = (s) =>
        String(s || "")
          .replace(/#< CLIXML[\s\S]*$/i, "")
          .replace(/<Objs[\s\S]*$/i, "")
          .trim();
      const msg = clean(errOut) || clean(out) || "退出码 " + String(code);
      finish({ ok: false, error: msg.slice(0, 400) });
    });
  });
}

/* 往系统剪贴板写文件列表（mode: "copy" | "cut"）。
   返回 { ok, count, error }；失败时调用方仍可保留内部剪贴板（渲染层会提示）。 */
async function fsClipWrite(paths, mode, deps) {
  const list = (Array.isArray(paths) ? paths : [])
    .map((p) => String(p == null ? "" : p).trim())
    .filter(Boolean);
  if (!list.length) return { ok: false, count: 0, error: "没有文件" };
  if (list.length > FS_CLIP_MAX_ITEMS)
    return { ok: false, count: 0, error: "一次最多 " + FS_CLIP_MAX_ITEMS + " 项" };
  if (process.platform !== "win32" && !(deps && deps.force))
    return { ok: false, count: 0, error: "仅支持 Windows" };
  const script = fsClipBuildWriteScript(list, mode);
  const r = await fsClipRunScript(script, deps);
  if (!r.ok) return { ok: false, count: 0, error: r.error || "写入剪贴板失败" };
  return { ok: true, count: list.length, mode: String(mode) === "cut" ? "cut" : "copy" };
}

/* 读系统剪贴板里的文件列表。返回 { ok, effect, paths:[绝对路径], error }。
   临时文件只用来跨进程传 JSON（PowerShell 的 stdout 受控制台代码页影响，中文会乱码）。 */
async function fsClipRead(deps) {
  if (process.platform !== "win32" && !(deps && deps.force))
    return { ok: false, effect: "copy", paths: [], error: "仅支持 Windows" };
  const tmp = path.join(
    os.tmpdir(),
    "mtnode-fsclip-" + process.pid + "-" + crypto.randomBytes(4).toString("hex") + ".json",
  );
  try {
    const r = await fsClipRunScript(fsClipBuildReadScript(tmp), deps);
    if (!r.ok) return { ok: false, effect: "copy", paths: [], error: r.error || "读取剪贴板失败" };
    let json = null;
    try {
      json = JSON.parse(fs.readFileSync(tmp, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      return {
        ok: false,
        effect: "copy",
        paths: [],
        error: "解析剪贴板内容失败：" + String((err && err.message) || err),
      };
    }
    const norm = fsClipNormalizeRead(json);
    return { ok: true, effect: norm.effect, paths: norm.paths };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

module.exports = {
  FS_CLIP_MAX_ITEMS,
  FS_CLIP_TIMEOUT_MS,
  fsClipNormEntry,
  fsClipParseList,
  fsClipEffectFromBytes,
  fsClipNormalizeRead,
  fsClipPsQuote,
  fsClipBuildWriteScript,
  fsClipBuildReadScript,
  fsClipPwshExe,
  fsClipRunScript,
  fsClipWrite,
  fsClipRead,
};

'use strict'
/**
 * MTNode 错误 / 崩溃诊断日志。
 * - 持续追加 error.log
 * - 严重错误自动落盘 crash-reports/*.txt，便于用户导出提交
 * - 导出时打成单份诊断包（含环境信息 + 日志尾部），不含 API Key
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app, dialog, shell, BrowserWindow } = require('electron')

const MAX_ERROR_LOG_BYTES = 4 * 1024 * 1024
const MAX_REPORTS = 30
const TAIL_BYTES = 256 * 1024

let getDataDir = () => ''
let getVersion = () => '0.0.0'
let t = (s) => s
let lastReportPath = ''
let dialogBusy = false

function init(opts) {
  if (opts && typeof opts.getDataDir === 'function') getDataDir = opts.getDataDir
  if (opts && typeof opts.getVersion === 'function') getVersion = opts.getVersion
  if (opts && typeof opts.t === 'function') t = opts.t
}

function logsDir() {
  const d = path.join(getDataDir(), 'logs')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function reportsDir() {
  const d = path.join(logsDir(), 'crash-reports')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function errorLogPath() {
  /* 兼容旧路径 DATA()/error.log；新写入同时落到 logs/error.log */
  return path.join(getDataDir(), 'error.log')
}

function errorLogPathNew() {
  return path.join(logsDir(), 'error.log')
}

function appendBoth(line) {
  const text = '[' + new Date().toISOString() + '] ' + line + '\n'
  for (const p of [errorLogPath(), errorLogPathNew()]) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.appendFileSync(p, text, 'utf8')
      rotateIfHuge(p)
    } catch (_) {}
  }
}

function rotateIfHuge(p) {
  try {
    const st = fs.statSync(p)
    if (st.size <= MAX_ERROR_LOG_BYTES) return
    const bak = p + '.1'
    try {
      fs.rmSync(bak, { force: true })
    } catch (_) {}
    fs.renameSync(p, bak)
  } catch (_) {}
}

function errLog(msg) {
  appendBoth(String(msg == null ? '' : msg))
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  )
}

function readTail(file, maxBytes) {
  try {
    if (!fs.existsSync(file)) return ''
    const st = fs.statSync(file)
    const size = st.size
    const fd = fs.openSync(file, 'r')
    try {
      const n = Math.min(size, maxBytes || TAIL_BYTES)
      const buf = Buffer.alloc(n)
      fs.readSync(fd, buf, 0, n, Math.max(0, size - n))
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    return '(read failed: ' + ((e && e.message) || e) + ')'
  }
}

function envBlock() {
  const lines = [
    'MTNode Diagnostic Report',
    '========================',
    'time: ' + new Date().toISOString(),
    'version: ' + getVersion(),
    'electron: ' + process.versions.electron,
    'chrome: ' + process.versions.chrome,
    'node: ' + process.versions.node,
    'platform: ' + process.platform + ' ' + os.release(),
    'arch: ' + process.arch,
    'locale: ' + (app.getLocale ? app.getLocale() : ''),
    'packaged: ' + !!app.isPackaged,
    'execPath: ' + process.execPath,
    'dataDir: ' + getDataDir(),
    'cwd: ' + process.cwd(),
    'pid: ' + process.pid,
    '',
  ]
  return lines.join('\n')
}

function pruneReports() {
  try {
    const dir = reportsDir()
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^MTNode-crash-.*\.txt$/i.test(n))
      .map((n) => {
        const p = path.join(dir, n)
        let mtime = 0
        try {
          mtime = fs.statSync(p).mtimeMs
        } catch (_) {}
        return { n, p, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (let i = MAX_REPORTS; i < files.length; i++) {
      try {
        fs.rmSync(files[i].p, { force: true })
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * @param {{ kind: string, message?: string, stack?: string, extra?: string, silent?: boolean }} info
 * @returns {string} report path (may be empty on failure)
 */
function saveCrashReport(info) {
  const kind = (info && info.kind) || 'error'
  const message = String((info && info.message) || '')
  const stack = String((info && info.stack) || '')
  const extra = String((info && info.extra) || '')
  errLog(kind + ': ' + (stack || message || '(no message)'))

  let body = envBlock()
  body += 'kind: ' + kind + '\n'
  body += 'message: ' + message + '\n'
  if (stack) body += '\n--- stack ---\n' + stack + '\n'
  if (extra) body += '\n--- extra ---\n' + extra + '\n'
  body += '\n--- error.log (tail) ---\n'
  body += readTail(errorLogPath(), TAIL_BYTES) || readTail(errorLogPathNew(), TAIL_BYTES)
  body += '\n\n--- dsh.log (tail) ---\n'
  body += readTail(path.join(getDataDir(), 'dsh.log'), Math.floor(TAIL_BYTES / 2))
  body += '\n'

  const out = path.join(reportsDir(), 'MTNode-crash-' + stamp() + '.txt')
  try {
    fs.writeFileSync(out, body, 'utf8')
    lastReportPath = out
    pruneReports()
    return out
  } catch (e) {
    errLog('saveCrashReport failed: ' + ((e && e.message) || e))
    return ''
  }
}

async function promptAfterCrash(reportPath, summary) {
  if (dialogBusy) return
  dialogBusy = true
  try {
    const win =
      BrowserWindow.getFocusedWindow() ||
      (BrowserWindow.getAllWindows()[0] || null)
    const detail =
      String(summary || '').slice(0, 800) +
      (reportPath
        ? '\n\n' + t('诊断日志已自动保存：') + '\n' + reportPath
        : '')
    const r = await dialog.showMessageBox(win || undefined, {
      type: 'error',
      title: t('MTNode AI编排器 发生错误'),
      message: t('应用内部出现错误。可将诊断日志提交给开发者以便排查。'),
      detail,
      buttons: [
        t('导出诊断日志…'),
        t('打开日志文件夹'),
        t('关闭'),
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (r.response === 0) await exportDiagnosticBundle({ preferPath: reportPath })
    else if (r.response === 1) openLogsFolder()
  } catch (e) {
    errLog('promptAfterCrash: ' + ((e && e.message) || e))
  } finally {
    dialogBusy = false
  }
}

function buildExportBundle(preferPath) {
  let body = envBlock()
  body += 'exportedAt: ' + new Date().toISOString() + '\n'
  body += 'note: API keys and secrets are NOT included.\n\n'

  if (preferPath && fs.existsSync(preferPath)) {
    body += '--- preferred crash report ---\n'
    body += 'path: ' + preferPath + '\n\n'
    try {
      body += fs.readFileSync(preferPath, 'utf8') + '\n'
    } catch (_) {}
  }

  body += '\n--- error.log (tail) ---\n'
  body += readTail(errorLogPath(), TAIL_BYTES) || readTail(errorLogPathNew(), TAIL_BYTES)
  body += '\n\n--- logs/error.log (tail) ---\n'
  body += readTail(errorLogPathNew(), TAIL_BYTES)
  body += '\n\n--- dsh.log (tail) ---\n'
  body += readTail(path.join(getDataDir(), 'dsh.log'), Math.floor(TAIL_BYTES / 2))

  try {
    const dir = reportsDir()
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^MTNode-crash-.*\.txt$/i.test(n))
      .map((n) => {
        const p = path.join(dir, n)
        let mtime = 0
        try {
          mtime = fs.statSync(p).mtimeMs
        } catch (_) {}
        return { n, p, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5)
    body += '\n\n--- recent crash-reports (names) ---\n'
    for (const f of files) body += f.n + '\n'
    if (files[0] && (!preferPath || preferPath !== files[0].p)) {
      body += '\n--- latest crash report content ---\n'
      try {
        body += fs.readFileSync(files[0].p, 'utf8') + '\n'
      } catch (_) {}
    }
  } catch (_) {}

  return body
}

async function exportDiagnosticBundle(opts) {
  const preferPath = opts && opts.preferPath
  const win =
    BrowserWindow.getFocusedWindow() ||
    (BrowserWindow.getAllWindows()[0] || null)
  const defaultName = 'MTNode-diagnostic-' + stamp() + '.txt'
  const r = await dialog.showSaveDialog(win || undefined, {
    title: t('导出诊断日志'),
    defaultPath: path.join(app.getPath('desktop'), defaultName),
    filters: [{ name: 'Diagnostic Log', extensions: ['txt'] }],
  })
  if (r.canceled || !r.filePath) return { ok: false, canceled: true }
  try {
    const body = buildExportBundle(preferPath || lastReportPath)
    fs.writeFileSync(r.filePath, body, 'utf8')
    try {
      shell.showItemInFolder(r.filePath)
    } catch (_) {}
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}

function openLogsFolder() {
  try {
    const d = logsDir()
    shell.openPath(d)
    return { ok: true, path: d }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}

function status() {
  const legacy = errorLogPath()
  const modern = errorLogPathNew()
  let errorBytes = 0
  let errorMtime = null
  for (const p of [modern, legacy]) {
    try {
      if (!fs.existsSync(p)) continue
      const st = fs.statSync(p)
      if (st.size > errorBytes) {
        errorBytes = st.size
        errorMtime = st.mtime.toISOString()
      }
    } catch (_) {}
  }
  let latestReport = null
  let reportCount = 0
  try {
    const files = fs
      .readdirSync(reportsDir())
      .filter((n) => /^MTNode-crash-.*\.txt$/i.test(n))
    reportCount = files.length
    const sorted = files
      .map((n) => {
        const p = path.join(reportsDir(), n)
        let mtime = 0
        try {
          mtime = fs.statSync(p).mtimeMs
        } catch (_) {}
        return { n, p, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    if (sorted[0]) {
      latestReport = {
        name: sorted[0].n,
        path: sorted[0].p,
        mtime: new Date(sorted[0].mtime).toISOString(),
      }
    }
  } catch (_) {}
  return {
    ok: true,
    logsDir: logsDir(),
    errorLogPath: fs.existsSync(modern) ? modern : legacy,
    errorBytes,
    errorMtime,
    reportCount,
    latestReport,
    lastReportPath: lastReportPath || (latestReport && latestReport.path) || '',
  }
}

function installProcessHandlers() {
  process.on('uncaughtException', (err) => {
    const report = saveCrashReport({
      kind: 'main-uncaughtException',
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : String(err),
    })
    promptAfterCrash(
      report,
      err && err.message ? err.message : String(err),
    ).catch(() => {})
  })
  process.on('unhandledRejection', (reason) => {
    const msg =
      reason && reason.message
        ? reason.message
        : String(reason == null ? 'unknown' : reason)
    const stack = reason && reason.stack ? reason.stack : ''
    /* 多数 rejection 非致命：只追加 error.log，避免刷满 crash-reports */
    errLog(
      'main-unhandledRejection: ' +
        msg +
        (stack ? '\n' + stack : ''),
    )
  })
}

function installAppHandlers() {
  app.on('render-process-gone', (_e, _wc, details) => {
    const report = saveCrashReport({
      kind: 'render-process-gone',
      message: (details && details.reason) || 'gone',
      extra: JSON.stringify(details || {}, null, 2),
    })
    promptAfterCrash(
      report,
      t('渲染进程异常退出：') + ((details && details.reason) || ''),
    ).catch(() => {})
  })
  app.on('child-process-gone', (_e, details) => {
    saveCrashReport({
      kind: 'child-process-gone',
      message: (details && (details.type || details.reason)) || 'gone',
      extra: JSON.stringify(details || {}, null, 2),
    })
  })
}

function logRendererError(payload) {
  const kind = (payload && payload.kind) || 'renderer-error'
  const message = String((payload && payload.message) || '')
  const stack = String((payload && payload.stack) || '')
  const source = String((payload && payload.source) || '')
  errLog(
    kind +
      ': ' +
      message +
      (source ? ' @ ' + source : '') +
      (stack ? '\n' + stack : ''),
  )
  /* 渲染层常见脚本错不弹模态框，避免打断操作；用户可在设置里导出 */
  if (payload && payload.fatal) {
    const report = saveCrashReport({
      kind: kind + '-fatal',
      message,
      stack,
      extra: source,
    })
    return { ok: true, reportPath: report }
  }
  return { ok: true }
}

module.exports = {
  init,
  errLog,
  saveCrashReport,
  exportDiagnosticBundle,
  openLogsFolder,
  status,
  installProcessHandlers,
  installAppHandlers,
  logRendererError,
  errorLogPath,
  logsDir,
}

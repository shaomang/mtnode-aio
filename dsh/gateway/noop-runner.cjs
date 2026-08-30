// no-op sandbox runner (Windows console-flash workaround)
//
// The dsh sandbox seam on Windows wraps every confined command in the
// windows-acl runner (CreateProcessAsUserW with a WRITE_RESTRICTED token).
// That runner deliberately omits CREATE_NO_WINDOW — under a restricted token
// a hidden console dies with STATUS_DLL_INIT_FAILED (0xC0000142) — so its
// child inherits no console from the runner (the runner itself is spawned
// with windowsHide) and Windows flashes a fresh console window per call.
//
// This runner is the configured `runnerCommand` on win32: it ignores the
// bwrap-style profile arguments the seam prepends, finds the `--` separator,
// and spawns the wrapped command directly with windowsHide. The command
// therefore never runs under a restricted token; file-write containment is
// still enforced in-process by @deepseek-ai/dsh-fs-sandbox (a pure path check,
// no subprocess), so write/edit tools keep their policy fence. The trade-off
// is accepted deliberately: process-level ACL isolation on Windows is
// "partial" anyway, and a flashing console on every tool call is worse.
//
// Contract (see dsh-sandbox-local confine()): argv is
//   [node, noop-runner.cjs, ...bwrapProfileArgs(policy), "--", ...command]
// Exit code and stdio are passed through untouched.
'use strict'
const { spawn } = require('node:child_process')

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
if (sep < 0 || sep + 1 >= argv.length) {
  process.stderr.write('noop-runner: missing "--" separator in argv\n')
  process.exit(127)
}
const command = argv.slice(sep + 1)

const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})
child.on('error', (err) => {
  process.stderr.write('noop-runner: spawn failed: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exit(127)
})
child.on('exit', (code, signal) => {
  if (signal) {
    try { process.kill(process.pid, signal) } catch {}
    return
  }
  process.exit(code === null ? 1 : code)
})

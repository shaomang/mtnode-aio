// Main-process adapter for the MTNode agent gateway.
//
// This module speaks ONLY the mtnode-owned line-delimited JSON protocol
// documented in ../DESIGN.md. It never imports dsh code: dsh release churn
// is absorbed by dsh/gateway/gateway.mjs, so a dsh upgrade does not touch
// this file, main.js, preload.js, or app.js.

'use strict'

const { spawn } = require('child_process')
const { createInterface } = require('readline')
const { app } = require('electron')
const path = require('path')
const fs = require('fs')

/* 统一 Node:gateway 与 dsh 运行时都用 Electron 自带 Node 启动
   (process.execPath + ELECTRON_RUN_AS_NODE=1),用户无需安装 Node,
   版本与应用完全一致(Electron 39 = Node 22.22.1,满足 dsh ^22.19)。 */
function nodeCommand() {
  return process.execPath
}

/* 打包后 gateway(含 cordis.yml 与 node_modules)经 electron-builder
   extraResources 放在 resources/dsh/gateway —— 普通 Node 子进程无法读取
   asar 内文件,因此 gateway 必须始终落在真实文件系统上。 */
const GATEWAY_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'dsh', 'gateway', 'gateway.mjs')
  : path.join(__dirname, 'gateway', 'gateway.mjs')

function createDshAdapter(opts) {
  const { dataDir, errLog, log } = opts
  const dshHome = path.join(dataDir, 'dsh-home')

  let child = null
  let rl = null
  let nextId = 1
  let booting = null
  let closed = false
  const pending = new Map()
  const activeRuns = new Set()
  const onEvent = opts.onEvent || (() => {})

  function out(msg) {
    if (child && child.stdin && !child.stdin.destroyed) {
      try { child.stdin.write(JSON.stringify(msg) + '\n') } catch {}
    }
  }

  function startGateway() {
    if (child && !child.killed && child.exitCode === null) return
    const node = nodeCommand()
    fs.mkdirSync(dshHome, { recursive: true })
    const env = { ...process.env }
    env.ELECTRON_RUN_AS_NODE = '1'
    env.DSH_HOME = dshHome
    delete env.DSH_SESSION_ID
    delete env.DSH_SESSION_JSONL
    delete env.DSH_WEB_URL
    delete env.DSH_SHELL
    log('dsh gateway spawn: ' + node + ' ' + GATEWAY_PATH)
    child = spawn(node, [GATEWAY_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    })
    rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg
      try { msg = JSON.parse(trimmed) } catch { return }
      if (msg.event) {
        if (msg.event && msg.event.type === 'done' && msg.event.reqId) {
          activeRuns.delete(msg.event.reqId)
        }
        onEvent(msg.event)
        return
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      }
    })
    let errTail = ''
    child.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-4000)
      log('dsh gateway stderr: ' + d.toString().slice(0, 500))
    })
    child.on('error', (err) => {
      errLog('dsh gateway spawn error: ' + (err && err.message ? err.message : err))
      failPending('dsh 网关启动失败:' + (err && err.message ? err.message : err))
    })
    child.on('exit', (code) => {
      log('dsh gateway exit code=' + code)
      if (errTail && code !== 0) errLog('dsh gateway exited ' + code + ': ' + errTail.slice(-1500))
      failPending('dsh 网关已退出(code=' + code + ')')
      /* 网关消失：给所有在途 run 合成 error+done，避免渲染层永久等待 */
      for (const reqId of Array.from(activeRuns)) {
        activeRuns.delete(reqId)
        onEvent({ reqId, type: 'error', data: { message: '智能引擎已断开(code=' + code + ')，请重试' } })
        onEvent({ reqId, type: 'done', data: { finalResponse: '' } })
      }
      if (rl) { try { rl.close() } catch {} }
      rl = null
      child = null
      /* 允许下次请求重新拉起网关(应用常驻期间引擎自愈) */
      booting = null
    })
  }

  function failPending(reason) {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    pending.clear()
  }

  function request(method, params, timeoutMs) {
    if (closed) return Promise.reject(new Error('dsh 适配器已关闭'))
    booting = booting || Promise.resolve().then(() => startGateway())
    return booting.then(() => {
      if (!child) {
        return Promise.reject(new Error('dsh 网关未运行(应用自带 Node 无需安装),稍后重试'))
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`dsh 请求超时:${method}`))
        }, timeoutMs || 60000)
        pending.set(id, { resolve, reject, timer })
        out({ id, method, params })
      })
    })
  }

  return {
    gatewayPath: GATEWAY_PATH,
    dshHome,

    /* 随应用启动:幂等,已运行则直接复用(避免重复运行) */
    ensureStarted() {
      if (closed) return Promise.resolve(false)
      return request('status', undefined, 30000)
        .then(() => true)
        .catch((err) => {
          log('dsh gateway ensureStarted: ' + (err && err.message ? err.message : err))
          return false
        })
    },

    status() {
      return request('status', undefined, 30000)
    },

    run(params) {
      // params: { reqId, workspace, input, model, maxTokens, apiKey, baseUrl, systemPrompt }
      if (!params || !params.reqId) return Promise.reject(new Error('run 需要 reqId'))
      const withHome = Object.assign({}, params, { dshHome })
      return request('run', withHome, 30000).then((res) => {
        if (res && res.accepted) activeRuns.add(params.reqId)
        return res
      })
    },

    pluginList() {
      return request('pluginList', undefined, 30000)
    },

    pluginAdd(pkg) {
      return request('pluginAdd', { pkg }, 600000)
    },

    pluginRemove(pkg) {
      return request('pluginRemove', { pkg }, 600000)
    },

    pluginSetEnabled(pkg, enabled) {
      return request(enabled ? 'pluginEnable' : 'pluginDisable', { pkg }, 120000)
    },

    mcpList() {
      return request('mcpList', undefined, 30000)
    },

    mcpAdd(cfg) {
      return request('mcpAdd', cfg, 60000)
    },

    mcpRemove(serverName) {
      return request('mcpRemove', { serverName }, 60000)
    },

    mcpSetEnabled(serverName, enabled) {
      return request('mcpSetEnabled', { serverName, enabled }, 60000)
    },

    cancel(params) {
      return request('cancel', params, 30000)
    },

    /* 渲染层回答模型提问 / 审批(交互 id 由网关在事件里下发) */
    interact(params) {
      return request('interact', params, 30000)
    },

    providerCatalog() {
      return request('providerCatalog', undefined, 30000)
    },

    /* ── skills:文件系统技能,$DSH_HOME/skills/<name>/SKILL.md ──
       运行时 skill-filesystem 提供者自动发现 user-dsh 根,无需重启引擎。 */
    skillList() {
      try {
        const root = path.join(dshHome, 'skills')
        if (!fs.existsSync(root)) return { skills: [] }
        const out = []
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (!e.isDirectory()) continue
          const skillMd = path.join(root, e.name, 'SKILL.md')
          let description = ''
          if (fs.existsSync(skillMd)) {
            const text = fs.readFileSync(skillMd, 'utf8')
            const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/) ||
              text.match(/^description:\s*(.+)$/m)
            if (m) description = (m[1] || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('description:')).map((l) => l.replace(/^description:\s*['"]?/, '').replace(/['"]$/, '')).join('; ') || (m[2] || '').trim()
          }
          out.push({ name: e.name, description: String(description).slice(0, 200) })
        }
        return { skills: out }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },

    skillAdd({ name, description, body }) {
      try {
        const nm = String(name || '').trim().toLowerCase()
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nm)) {
          return { ok: false, error: '技能名需为 kebab-case(小写字母/数字/短横线)' }
        }
        const dir = path.join(dshHome, 'skills', nm)
        if (fs.existsSync(dir)) return { ok: false, error: '同名技能已存在' }
        fs.mkdirSync(dir, { recursive: true })
        const front = [
          '---',
          'name: ' + nm,
          'description: ' + String(description || '').replace(/\n/g, ' '),
          '---',
          '',
        ].join('\n')
        fs.writeFileSync(path.join(dir, 'SKILL.md'), front + String(body || ''), 'utf8')
        return { ok: true, skills: this.skillList().skills }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },

    skillRemove(name) {
      try {
        const nm = String(name || '').trim()
        const dir = path.join(dshHome, 'skills', nm)
        if (!nm || !fs.existsSync(dir)) return { ok: false, error: '技能不存在' }
        fs.rmSync(dir, { recursive: true, force: true })
        return { ok: true, skills: this.skillList().skills }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },

    shutdown() {
      closed = true
      if (!child) return Promise.resolve()
      return new Promise((resolve) => {
        const t = setTimeout(resolve, 3000)
        try {
          out({ id: nextId++, method: 'shutdown' })
          child.once('exit', () => { clearTimeout(t); resolve() })
        } catch { clearTimeout(t); resolve() }
      })
    },
  }
}

module.exports = { createDshAdapter, GATEWAY_PATH }

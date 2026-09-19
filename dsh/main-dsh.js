// Main-process adapter for the MTNode agent gateway.
//
// This module speaks ONLY the mtnode-owned line-delimited JSON protocol
// documented in ../DESIGN.md. It never imports dsh code: dsh release churn
// is absorbed by dsh/gateway/gateway.mjs, so a dsh upgrade does not touch
// this file, main.js, preload.js, or app.js.

'use strict'

const { spawn } = require('child_process')
const crypto = require('crypto')
const { createInterface } = require('readline')
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const {
  syncMtnodeAgentSkills,
  mtnodeAgentSkillIndex,
  getMtnodeAgentSkill,
} = require('../mtnode-agent-skills-lib.js')

/**
 * 插件安装专用 skill：同步到 dsh-home 供 Agent 调用，但不进入用户技能列表/工坊。
 * 真源一律是仓库根 `skills/<name>/SKILL.md`（各后端宿主目录不再留副本，
 * 否则改一处漏一处，Agent 拿到的就是旧提示词）。
 */
const INSTALL_SKILL_SOURCES = {
  'minimax-h3-install': path.join(__dirname, '..', 'skills', 'minimax-h3-install', 'SKILL.md'),
  'minimax-music3-install': path.join(__dirname, '..', 'skills', 'minimax-music3-install', 'SKILL.md'),
  'tts-local-install': path.join(__dirname, '..', 'skills', 'tts-local-install', 'SKILL.md'),
  'llama-local-install': path.join(__dirname, '..', 'skills', 'llama-local-install', 'SKILL.md'),
  'asr-local-install': path.join(__dirname, '..', 'skills', 'asr-local-install', 'SKILL.md'),
  'sensenova-local-install': path.join(__dirname, '..', 'skills', 'sensenova-local-install', 'SKILL.md'),
}
const INSTALL_SKILL_NAMES = new Set(Object.keys(INSTALL_SKILL_SOURCES))

/** 技能正文内容指纹（十六进制 sha256，与 ext-repo/build.mjs 的目录字段同算法）。
 *  用途：在线目录 / 工坊按「已安装 vs 远端」判是否有更新 —— 只看 version 的旧口径
 *  漏掉了「同版本号改了正文」，用户就永远拿不到新版提示词技能。 */
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

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
  const appRoot = opts.appRoot || path.join(__dirname, '..')
  const dshHome = path.join(dataDir, 'dsh-home')

  let child = null
  let rl = null
  let nextId = 1
  let booting = null
  let closed = false
  const pending = new Map()
  const activeRuns = new Set()
  /* 本适配器见过「已要求暂停」的那一轮：reqId -> {at, cancelTag}。
     pause 是同步往返：宿主这一跳 30s 超时、或网关那 10s 没回音时，暂停很可能已经落地
     （运行时收到 pause 就在同一拍 abort 收尾，那一轮随之从网关在途表消失）。
     这时用户再点一次「暂停」不该看到失败 —— 同一条在途轮直接回 ok + idempotent。
     随该轮 done 事件删除，所以按 cancelTag 兜底匹配也只可能命中「还没收尾」的那一轮
     （只给了 cancelTag、没给 reqId 的调用就是这么个情形）；整表上限兜底，网关退出即清空。 */
  const pausedReqIds = new Map()
  const PAUSED_REQS_MAX = 512
  const onEvent = opts.onEvent || (() => {})

  function notePausedReq(reqId, cancelTag) {
    const id = reqId == null ? '' : String(reqId).trim()
    if (!id) return
    pausedReqIds.set(id, { at: Date.now(), cancelTag: cancelTag ? String(cancelTag) : '' })
    while (pausedReqIds.size > PAUSED_REQS_MAX) {
      const oldest = pausedReqIds.keys().next().value
      if (oldest === undefined) break
      pausedReqIds.delete(oldest)
    }
  }

  /* 这一轮是否已被要求暂停：reqId 最准；只给 cancelTag 时扫表（见上面注释的口径）。 */
  function seenPausedReq(p) {
    if (p.reqId && pausedReqIds.has(p.reqId)) return true
    if (!p.cancelTag) return false
    for (const e of pausedReqIds.values()) if (e.cancelTag && e.cancelTag === p.cancelTag) return true
    return false
  }

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
          pausedReqIds.delete(msg.event.reqId)
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
      /* 引擎都没了，在途轮的暂停存根一并作废（重拉起后的轮次是全新 reqId） */
      pausedReqIds.clear()
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

  /* steer / pause 的点名参数：只透传最小字段 {reqId|cancelTag, sessionId?, 正文?}。
     网关按在途表(reqId → 那一轮的 runtime)寻址，用不上工作区，因此不像 run 那样
     补 dshHome —— 多带无关字段只会让老网关对参数形状产生误解。 */
  function inflightParams(params) {
    const p = params || {}
    const o = {}
    for (const k of ['reqId', 'cancelTag', 'sessionId']) {
      const v = p[k] == null ? '' : String(p[k]).trim()
      if (v) o[k] = v
    }
    const text = [p.text, p.content, p.input, p.message].find(
      (x) => typeof x === 'string' && x.trim(),
    )
    if (text) o.text = text
    if (Array.isArray(p.contentBlocks) && p.contentBlocks.length) o.contentBlocks = p.contentBlocks
    return o
  }

  /* 超时文案由 request() 自己铸造（`dsh 请求超时:<method>`），认它即可：
     超时 ≠ 失败 —— 那一侧的请求很可能已经生效，只是没赶上回音。 */
  function isTimeoutErr(err) {
    return /请求超时/.test(String((err && err.message) || err))
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

    pluginSetEnabled(pkg, enabled, id) {
      return request(enabled ? 'pluginEnable' : 'pluginDisable', { pkg, id }, 120000)
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

    /* 插话：往「此刻正在跑的这一轮」的下一步边界投一句话(运行时侧 agent.steer)，
       不等本轮跑完，模型下一步就带着这句继续。只在本轮真在途时有效。
       网关回 {ok:false, reason:'unsupported'}(没有在途这一轮 / 老运行时没有该方法)
       时，调用方一律回落成「排队消息」—— 那是保底路径，不是发送失败。
       超时单独成形：请求可能已经落进运行时，只是没回音；插话可安全重发
       (最多让模型多看一眼同一句话)，故回 retryable:true，由调用方决定是否补发。 */
    steer(params) {
      const p = inflightParams(params)
      if (!p.reqId && !p.cancelTag) return Promise.reject(new Error('steer 需要 reqId 或 cancelTag'))
      if (!p.text && !p.contentBlocks) return Promise.reject(new Error('steer 需要插话正文(text / contentBlocks)'))
      return request('steer', p, 30000).catch((err) => {
        if (isTimeoutErr(err)) return { ok: false, reason: 'timeout', retryable: true, error: (err && err.message) || String(err) }
        throw err
      })
    },

    /* 暂停：让正在跑的这一轮停在当前步(cancel{kind:'user'} + keepInbox)——
       与 cancel 的关键区别是不关 runtime 进程、保留上下文，之后可继续跑。
       成功后本轮以 done{paused:true} 收尾(网关保证不会有 error)。
       幂等：同一条在途轮只要见过一次成功的暂停(含超时但可能已落地)，再点暂停直接回
       ok + idempotent:true —— 告诉调用方「这一轮已经不在往前跑了」，别报失败。 */
    pause(params) {
      const p = inflightParams(params)
      if (!p.reqId && !p.cancelTag) return Promise.reject(new Error('pause 需要 reqId 或 cancelTag'))
      const again = seenPausedReq(p)
      return request('pause', p, 30000).then((res) => {
        if (res && res.ok) {
          /* 网关会把这一轮真正的 reqId(以及同标签并发时的 reqIds)带回来，按它记账，
             这样下一次即便只给 reqId 或只给 cancelTag 都认得出来是同一轮。 */
          const ids = [res.reqId].concat(Array.isArray(res.reqIds) ? res.reqIds : [])
          for (const id of ids) notePausedReq(id, p.cancelTag || res.cancelTag)
          return res
        }
        if (again) return Object.assign({}, res || {}, { ok: true, paused: true, idempotent: true })
        return res
      }, (err) => {
        const message = (err && err.message) || String(err)
        if (isTimeoutErr(err)) {
          /* 请求已经发出去了，只是没赶上回音：先记账，后续同一条轮的再点按幂等成功处理 */
          notePausedReq(p.reqId, p.cancelTag)
          return { ok: false, reason: 'timeout', pending: true, error: message }
        }
        if (again) return { ok: true, paused: true, idempotent: true }
        throw err
      })
    },

    /* 回滚收尾：取回 gateway 侧「无在途 run」时暂存的 journal 帧。
       params {key?, workspace?, sessionId?, roundId?, peek?} → {entries:[{key,data}]} */
    rollbackDrain(params) {
      return request('rollbackDrain', params, 30000)
    },

    providerCatalog() {
      return request('providerCatalog', undefined, 30000)
    },

    /* ── skills:文件系统技能,$DSH_HOME/skills/<name>/SKILL.md ──
       运行时 skill-filesystem 提供者自动发现 user-dsh 根,无需重启引擎。
       插件安装用 skill 从仓库根 skills/ 同步到 dshHome（升级后覆盖），不进用户技能仓库 UI。
       创意工坊 / 扩展目录下载的技能不在此列，本地留存直至用户主动更新。 */
    syncInstallSkills() {
      try {
        const destRoot = path.join(dshHome, 'skills')
        fs.mkdirSync(destRoot, { recursive: true })
        for (const name of INSTALL_SKILL_NAMES) {
          const src = INSTALL_SKILL_SOURCES[name]
          if (!src || !fs.existsSync(src)) continue
          const destDir = path.join(destRoot, name)
          fs.mkdirSync(destDir, { recursive: true })
          fs.copyFileSync(src, path.join(destDir, 'SKILL.md'))
          fs.writeFileSync(path.join(destDir, '.install-only'), '1\n', 'utf8')
          try {
            const builtinMark = path.join(destDir, '.builtin')
            if (fs.existsSync(builtinMark)) fs.unlinkSync(builtinMark)
          } catch {}
        }
      } catch (err) {
        try { log('syncInstallSkills: ' + ((err && err.message) || err)) } catch {}
      }
    },

    syncMtnodeAgentSkills() {
      try {
        return syncMtnodeAgentSkills(dshHome, appRoot)
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) }
      }
    },

    mtnodeAgentSkillIndex() {
      try {
        this.syncMtnodeAgentSkills()
        return mtnodeAgentSkillIndex(dshHome, appRoot)
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) }
      }
    },

    mtnodeAgentSkillGet(name) {
      try {
        this.syncMtnodeAgentSkills()
        return getMtnodeAgentSkill(dshHome, name)
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) }
      }
    },

    _parseSkillMeta(text) {
      const meta = { title: '', description: '', version: '', name: '' }
      /* 归一换行：CRLF 的 SKILL.md 会让下面 `(.*)$` 的行匹配整行失败（`.` 不匹配 \r），
         导致 name / title / description 全部读空 —— 同步按目录名装技能，名字就错了。 */
      const raw = String(text || '').replace(/\r\n?/g, '\n')
      const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
      const body = fm ? fm[2] || '' : raw
      if (fm) {
        for (const line of fm[1].split('\n')) {
          const km = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
          if (!km) continue
          const k = km[1]
          const v = String(km[2] || '').replace(/^['"]|['"]$/g, '').trim()
          if (k === 'title') meta.title = v
          if (k === 'description') meta.description = v
          if (k === 'version') meta.version = v
          if (k === 'name') meta.name = v
        }
      }
      if (!meta.title) {
        const h1 = body.match(/^#\s+(.+)$/m)
        if (h1) meta.title = String(h1[1] || '').trim()
      }
      if (!meta.description) {
        const dm = raw.match(/^description:\s*(.+)$/m)
        if (dm) meta.description = String(dm[1] || '').trim()
      }
      return meta
    },

    _readStoreMeta(dir) {
      try {
        const p = path.join(dir, '.store-meta.json')
        if (!fs.existsSync(p)) return null
        return JSON.parse(fs.readFileSync(p, 'utf8'))
      } catch {
        return null
      }
    },

    _writeStoreMeta(dir, meta) {
      if (!meta) return
      fs.writeFileSync(
        path.join(dir, '.store-meta.json'),
        JSON.stringify(meta, null, 2) + '\n',
        'utf8',
      )
    },

    skillList() {
      try {
        this.syncInstallSkills()
        this.syncMtnodeAgentSkills()
        const root = path.join(dshHome, 'skills')
        if (!fs.existsSync(root)) return { skills: [] }
        const out = []
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (!e.isDirectory()) continue
          if (INSTALL_SKILL_NAMES.has(e.name)) continue
          if (e.name.endsWith('-install')) continue
          if (fs.existsSync(path.join(root, e.name, '.install-only'))) continue
          if (fs.existsSync(path.join(root, e.name, '.mtnode-internal'))) continue
          const skillMd = path.join(root, e.name, 'SKILL.md')
          let title = ''
          let description = ''
          let version = ''
          let sha256 = ''
          if (fs.existsSync(skillMd)) {
            const body = fs.readFileSync(skillMd)
            const meta = this._parseSkillMeta(body.toString('utf8'))
            title = meta.title || ''
            description = meta.description || ''
            version = meta.version || ''
            /* 正文内容指纹（与扩展目录 ext-repo/build.mjs 同算法）：
               在线目录 / 工坊里同版本号但正文改过的技能，靠它才能被判成「有更新」。 */
            sha256 = sha256Hex(body)
          }
          const builtin = fs.existsSync(path.join(root, e.name, '.builtin'))
          const store = this._readStoreMeta(path.join(root, e.name)) || {}
          out.push({
            name: e.name,
            title: String(title).slice(0, 80),
            description: String(description).slice(0, 200),
            version: String(store.version || version || '').slice(0, 32),
            sha256,
            builtin: !!builtin,
            storeId: store.storeId || '',
            storeUpdatedAt: store.updatedAt || 0,
            storeOfficial: !!store.official,
          })
        }
        out.sort((a, b) => {
          if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        return { skills: out }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },

    skillGet(name) {
      try {
        this.syncInstallSkills()
        const nm = String(name || '').trim().toLowerCase()
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nm)) {
          return { ok: false, error: '技能不存在' }
        }
        const root = path.resolve(path.join(dshHome, 'skills'))
        const dir = path.resolve(root, nm)
        const sep = root.endsWith(path.sep) ? root : root + path.sep
        if (dir !== root && !dir.startsWith(sep)) return { ok: false, error: '技能不存在' }
        const skillMd = path.join(dir, 'SKILL.md')
        if (!fs.existsSync(skillMd)) return { ok: false, error: '技能不存在' }
        const body = fs.readFileSync(skillMd, 'utf8')
        const installOnly =
          INSTALL_SKILL_NAMES.has(nm) ||
          fs.existsSync(path.join(dir, '.install-only'))
        const builtin =
          !installOnly && fs.existsSync(path.join(dir, '.builtin'))
        const store = this._readStoreMeta(dir) || {}
        const files = []
        try {
          const walk = (base, prefix) => {
            for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
              if (ent.name.startsWith('.')) continue
              const rel = prefix ? prefix + '/' + ent.name : ent.name
              const full = path.join(base, ent.name)
              if (ent.isDirectory()) walk(full, rel)
              else if (rel.replace(/\\/g, '/') !== 'SKILL.md') {
                const buf = fs.readFileSync(full)
                files.push({
                  path: rel.replace(/\\/g, '/'),
                  bytes: buf.length,
                  base64: buf.toString('base64'),
                })
              }
            }
          }
          walk(dir, '')
        } catch {}
        files.sort((a, b) => a.path.localeCompare(b.path))
        return {
          ok: true,
          name: nm,
          body,
          builtin: !!builtin,
          installOnly: !!installOnly,
          storeId: store.storeId || '',
          version: store.version || this._parseSkillMeta(body).version || '',
          storeUpdatedAt: store.updatedAt || 0,
          files,
        }
      } catch (err) {
        return { ok: false, error: err.message || String(err) }
      }
    },

    skillAdd({ name, description, body, overwrite, storeMeta, files }) {
      try {
        const nm = String(name || '').trim().toLowerCase()
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nm)) {
          return { ok: false, error: '技能名需为 kebab-case(小写字母/数字/短横线)' }
        }
        if (INSTALL_SKILL_NAMES.has(nm) || nm.endsWith('-install')) {
          return { ok: false, error: '插件安装技能名不可占用' }
        }
        const dir = path.join(dshHome, 'skills', nm)
        const exists = fs.existsSync(dir)
        if (exists && !overwrite) return { ok: false, error: '同名技能已存在' }
        if (exists && fs.existsSync(path.join(dir, '.builtin'))) {
          return { ok: false, error: '内置技能不可覆盖' }
        }
        /* 随应用内置的技能（含 skillList 不展示的 .mtnode-internal 一类）同样不许被
           工坊下载 / 用户新建顶掉：老版本这些名字来自创意工坊，用户机上可能还留着
           带 .store-meta.json 的同名目录，内置库同步会接管它，这里再堵死反向覆盖。 */
        if (
          exists &&
          (fs.existsSync(path.join(dir, '.mtnode-internal')) ||
            fs.existsSync(path.join(dir, '.mtnode-builtin')))
        ) {
          return { ok: false, error: '内置技能不可覆盖' }
        }
        if (exists && fs.existsSync(path.join(dir, '.install-only'))) {
          return { ok: false, error: '插件安装技能不可覆盖' }
        }
        fs.mkdirSync(dir, { recursive: true })
        let text = String(body || '')
        if (!/^---\s*\n/.test(text)) {
          text = [
            '---',
            'name: ' + nm,
            'description: ' + String(description || '').replace(/\n/g, ' '),
            '---',
            '',
            text,
          ].join('\n')
        }
        if (Buffer.byteLength(text, 'utf8') > 200 * 1024) {
          return { ok: false, error: '每个文件不能超过 200KB' }
        }
        fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8')
        if (Array.isArray(files)) {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (
              ent.name === 'SKILL.md' ||
              ent.name === '.builtin' ||
              ent.name === '.install-only' ||
              ent.name === '.store-meta.json'
            ) continue
            const p = path.join(dir, ent.name)
            if (ent.isDirectory()) fs.rmSync(p, { recursive: true, force: true })
            else try { fs.unlinkSync(p) } catch {}
          }
          for (const f of files) {
            const rel = String((f && (f.path || f.name)) || '').replace(/\\/g, '/').replace(/^\.\//, '')
            if (!rel || rel === 'SKILL.md' || rel.includes('..')) continue
            const parts = rel.split('/').filter(Boolean)
            if (!parts.every((x) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x))) continue
            let buf
            if (f.body != null) buf = Buffer.from(String(f.body), 'utf8')
            else if (f.base64) buf = Buffer.from(String(f.base64).replace(/\s+/g, ''), 'base64')
            else continue
            if (buf.length > 200 * 1024) {
              return { ok: false, error: '文件 ' + rel + ' 超过 200KB' }
            }
            const dest = path.join(dir, ...parts)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, buf)
          }
        }
        if (storeMeta && typeof storeMeta === 'object') {
          this._writeStoreMeta(dir, {
            storeId: String(storeMeta.storeId || ''),
            version: String(storeMeta.version || ''),
            updatedAt: Number(storeMeta.updatedAt) || Date.now(),
            official: !!storeMeta.official,
            title: String(storeMeta.title || ''),
          })
        }
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
        if (
          INSTALL_SKILL_NAMES.has(nm) ||
          fs.existsSync(path.join(dir, '.install-only'))
        ) {
          return { ok: false, error: '插件安装技能不可卸载' }
        }
        if (
          fs.existsSync(path.join(dir, '.mtnode-internal')) ||
          fs.existsSync(path.join(dir, '.mtnode-builtin'))
        ) {
          return { ok: false, error: 'MTNode 内置技能不可卸载' }
        }
        if (fs.existsSync(path.join(dir, '.builtin'))) {
          return { ok: false, error: '内置技能不可卸载' }
        }
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

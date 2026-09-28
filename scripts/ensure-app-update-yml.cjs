'use strict'
/**
 * electron-builder 仅在 Windows 目标含 nsis 时才会写入 resources/app-update.yml。
 * 本仓库 compile 使用 --dir，build 使用 --prepackaged，都会跳过该步骤。
 * electron-updater 下载更新时仍会读取该文件；缺失即 ENOENT。
 *
 * 在 afterPack / build.js 中调用，保证 win-unpacked 与安装包内始终带上该文件。
 */
const fs = require('fs')
const path = require('path')

const DEFAULT_URL = 'http://mt-agent.com/mtnode/updates'

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return JSON.parse(text)
}

/** 与 app-builder-lib sanitizeFileName 对齐的简化版（用于 updater 缓存目录名） */
function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveUpdateConfig(appRoot) {
  let url = DEFAULT_URL
  let name = 'mtnode-ai-orchestrator'
  try {
    const build = readJson(path.join(appRoot, 'build.json'))
    const pub = Array.isArray(build.publish) ? build.publish[0] : build.publish
    if (pub && pub.provider === 'generic' && pub.url) url = String(pub.url)
  } catch (_) {
    /* keep default */
  }
  try {
    const pkg = readJson(path.join(appRoot, 'package.json'))
    if (pkg && pkg.name) name = String(pkg.name)
  } catch (_) {
    /* keep default */
  }
  return {
    provider: 'generic',
    url,
    updaterCacheDirName: sanitizeFileName(name).toLowerCase() + '-updater',
  }
}

/**
 * @param {string} appOutDir  例如 dist/win-unpacked
 * @param {string} [appRoot]  含 build.json / package.json 的应用根目录
 * @returns {string} 写入的 app-update.yml 路径
 */
function ensureAppUpdateYml(appOutDir, appRoot) {
  const root = appRoot || path.join(__dirname, '..')
  const resources = path.join(appOutDir, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  const out = path.join(resources, 'app-update.yml')
  const cfg = resolveUpdateConfig(root)
  const body =
    `provider: ${cfg.provider}\n` +
    `url: ${cfg.url}\n` +
    `updaterCacheDirName: ${cfg.updaterCacheDirName}\n`
  fs.writeFileSync(out, body, 'utf8')
  return out
}

module.exports = {
  ensureAppUpdateYml,
  resolveUpdateConfig,
}

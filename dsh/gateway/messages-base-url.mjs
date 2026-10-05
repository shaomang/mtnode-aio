// dsh 0.2 的 `llm-deepseek` 把 `config.baseURL` / `DEEPSEEK_BASE_URL` 当作
// **Messages 兼容的端点根**，自己在其后拼 `/v1/messages`
// （见 @deepseek-ai/dsh-llm-deepseek 的 messagesApiRoot，以及它那句
// `protocol is not configurable; use a Messages-compatible baseURL`）。
//
// 而 MTNode 的服务商配置里存的是 **OpenAI 兼容根**（`https://api.deepseek.com`），
// 直接下发给 0.2 运行时会打到 `https://api.deepseek.com/v1/messages` ——
// 实测（2026-09-30，真 key）该地址 **404**，而 DeepSeek 的 Messages 面在
// `https://api.deepseek.com/anthropic`（`/anthropic/v1/messages` 实测 200）。
// 0.1 代没有这一层，所以升级到 0.2 后必须在这里补一次归一 ——
// 这是「网关吸收 dsh 的 API 变化」的一个具体例子。
//
// 口径（宁可少动）：只认 DeepSeek 官方域的**裸根**，补 `/anthropic`；
// 其它域、以及已经带路径的端点一律原样透传 —— 第三方走 pi-ai 路由，各自有自己的
// baseURL；用户手填的 Messages 根（第三方聚合端点等）不该被我们改。

/** DeepSeek 官方 Messages 面的路径前缀 */
const DEEPSEEK_MESSAGES_PATH = '/anthropic'
/** 官方域（含其子域） */
const DEEPSEEK_HOST = /(^|\.)api\.deepseek\.com$/i

/**
 * 把服务商配置里的 baseUrl 归一成 `llm-deepseek` 认的 Messages 端点根。
 * @param {string} raw 用户配置的 baseUrl（可为空 / 可带尾斜杠）
 * @returns {string} 归一后的 baseUrl（空输入回空串，绝不凭空造端点）
 */
export function messagesBaseUrl(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  let u
  try {
    u = new URL(s)
  } catch {
    /* 不是合法 URL：原样交回去，让运行时报它自己的错（我们不猜） */
    return s
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s
  if (!DEEPSEEK_HOST.test(u.hostname)) return s
  const path = u.pathname.replace(/\/+$/, '')
  if (path === '') return s.replace(/\/+$/, '') + DEEPSEEK_MESSAGES_PATH
  return s
}

/**
 * 该 baseUrl 是否已经是 Messages 端点根（自检 / 诊断用）。
 * @param {string} raw
 * @returns {boolean}
 */
export function isMessagesBaseUrl(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return false
  let u
  try {
    u = new URL(s)
  } catch {
    return false
  }
  if (!DEEPSEEK_HOST.test(u.hostname)) return true
  return u.pathname.replace(/\/+$/, '') !== ''
}

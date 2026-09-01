import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { URL } from 'node:url'

export interface RemoteAccessOptions {
  enabled?: boolean
  pairingTtlMs?: number
  sessionTtlMs?: number
  maxPairingFailures?: number
  failureWindowMs?: number
  blockMs?: number
  /** Primarily useful for hardened installations and deterministic HTTP tests. */
  authenticateLoopback?: boolean
  clock?: { now(): number }
  randomBytes?: (size: number) => Uint8Array
  /** Persist hashed sessions so remembered private devices survive restarts. */
  persistencePath?: string
}

export interface PairingCode {
  code: string
  expiresAt: number
}

export interface RemoteSession {
  token: string
  expiresAt: number
}

export type PairingExchange =
  | { ok: true; session: RemoteSession }
  | { ok: false; status: 'disabled' | 'invalid' | 'limited' }

type ExpiringHash = { expiresAt: number }
type FailureState = { windowStartedAt: number; failures: number; blockedUntil: number }

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 浏览器直连会话 Cookie：配对成功后下发，浏览器对同一源的所有请求（含图片/SSE/表单）自动携带。 */
export const REMOTE_SESSION_COOKIE = 'stagecraft_remote'

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.toLowerCase().split('%')[0]
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

export class RemoteAccessPolicy {
  readonly enabled: boolean
  readonly authenticateLoopback: boolean
  private readonly pairingTtlMs: number
  private readonly sessionTtlMsValue: number
  private readonly maxPairingFailures: number
  private readonly failureWindowMs: number
  private readonly blockMs: number
  private readonly clock: { now(): number }
  private readonly random: (size: number) => Uint8Array
  private readonly persistencePath?: string
  private readonly pairingCodes = new Map<string, ExpiringHash>()
  private readonly sessions = new Map<string, ExpiringHash>()
  private readonly failures = new Map<string, FailureState>()

  constructor(options: RemoteAccessOptions = {}) {
    this.enabled = options.enabled === true
    this.authenticateLoopback = options.authenticateLoopback === true
    this.pairingTtlMs = Math.max(1_000, options.pairingTtlMs ?? 5 * 60_000)
    // Remembered private devices should survive ordinary app restarts and
    // periods of inactivity; explicit configuration can still shorten this.
    this.sessionTtlMsValue = Math.max(1_000, options.sessionTtlMs ?? 30 * 24 * 60 * 60_000)
    this.maxPairingFailures = Math.max(1, options.maxPairingFailures ?? 5)
    this.failureWindowMs = Math.max(1_000, options.failureWindowMs ?? 60_000)
    this.blockMs = Math.max(1_000, options.blockMs ?? 60_000)
    this.clock = options.clock ?? Date
    this.random = options.randomBytes ?? (size => nodeRandomBytes(size))
    this.persistencePath = options.persistencePath
    this.loadPersistedSessions()
  }

  createPairingCode(): PairingCode {
    if (!this.enabled) throw new Error('Remote access is disabled.')
    this.prune()
    let code: string | undefined
    for (let attempt = 0; attempt < 8; attempt++) {
      const bytes = this.random(8)
      const candidate = Array.from(bytes, byte => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join('')
      if (!this.pairingCodes.has(hashSecret(candidate))) { code = candidate; break }
    }
    if (!code) throw new Error('Unable to generate a unique pairing code.')
    const expiresAt = this.clock.now() + this.pairingTtlMs
    this.pairingCodes.set(hashSecret(code), { expiresAt })
    return { code, expiresAt }
  }

  exchangePairingCode(code: string, clientKey: string): PairingExchange {
    if (!this.enabled) return { ok: false, status: 'disabled' }
    const now = this.clock.now()
    this.prune(now)
    if (this.isLimited(clientKey, now)) return { ok: false, status: 'limited' }
    const codeHash = hashSecret(code.trim().toUpperCase())
    const pending = this.pairingCodes.get(codeHash)
    if (!pending || pending.expiresAt <= now) return { ok: false, status: this.recordFailure(clientKey, now) ? 'limited' : 'invalid' }
    this.pairingCodes.delete(codeHash)
    this.failures.delete(clientKey)
    return { ok: true, session: this.issueSession(now) }
  }

  /**
   * ADB reverse（`adb reverse tcp:<port> tcp:<port>`）把手机的 localhost 端口映射到电脑
   * 本机回环：请求以 127.0.0.1 到达桌面，且只有已授权的 adb 设备能建立该隧道。因此
   * 回环设备可免配对码直接换取会话 token（配对码本身只防局域网第三方，不防本机回环）。
   */
  createTrustedSession(): RemoteSession {
    if (!this.enabled) throw new Error('Remote access is disabled.')
    this.prune()
    return this.issueSession(this.clock.now())
  }

  private issueSession(now: number): RemoteSession {
    let token: string | undefined
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = Buffer.from(this.random(32)).toString('base64url')
      if (!this.sessions.has(hashSecret(candidate))) { token = candidate; break }
    }
    if (!token) throw new Error('Unable to generate a unique remote session.')
    const expiresAt = now + this.sessionTtlMsValue
    this.sessions.set(hashSecret(token), { expiresAt })
    this.persistSessions()
    return { token, expiresAt }
  }

  authorize(token: string | undefined): boolean {
    if (!this.enabled || !token) return false
    const now = this.clock.now()
    const session = this.sessions.get(hashSecret(token))
    if (!session || session.expiresAt <= now) {
      if (session) this.sessions.delete(hashSecret(token))
      return false
    }
    // Sliding renewal keeps a remembered private device authorized across restarts
    // and long-lived use without weakening the initial pairing code.
    const renewed = now + this.sessionTtlMsValue
    if (renewed - session.expiresAt > this.sessionTtlMsValue / 4) { session.expiresAt = renewed; this.persistSessions() }
    return true
  }

  revokeSession(token: string): boolean {
    const removed = this.sessions.delete(hashSecret(token)); if (removed) this.persistSessions(); return removed
  }

  /** 会话有效期（毫秒）；用于 Cookie Max-Age。 */
  get sessionTtlMs(): number { return this.sessionTtlMsValue }

  /** 吊销全部会话（本机操作员应急 / 清除所有已配对手机）。 */
  revokeAllSessions(): number {
    const count = this.sessions.size
    this.sessions.clear()
    this.persistSessions()
    return count
  }

  private isLimited(clientKey: string, now: number): boolean {
    const state = this.failures.get(clientKey)
    if (!state) return false
    if (state.blockedUntil > now) return true
    if (now - state.windowStartedAt >= this.failureWindowMs) this.failures.delete(clientKey)
    return false
  }

  private recordFailure(clientKey: string, now: number): boolean {
    let state = this.failures.get(clientKey)
    if (!state || now - state.windowStartedAt >= this.failureWindowMs) state = { windowStartedAt: now, failures: 0, blockedUntil: 0 }
    state.failures++
    if (state.failures >= this.maxPairingFailures) state.blockedUntil = now + this.blockMs
    this.failures.set(clientKey, state)
    return state.blockedUntil > now
  }

  private prune(now = this.clock.now()): void {
    for (const [hash, value] of this.pairingCodes) if (value.expiresAt <= now) this.pairingCodes.delete(hash)
    for (const [hash, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(hash)
    for (const [key, value] of this.failures) if (value.blockedUntil <= now && now - value.windowStartedAt >= this.failureWindowMs) this.failures.delete(key)
  }

  private loadPersistedSessions(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return
    try {
      const records = JSON.parse(readFileSync(this.persistencePath, 'utf8')) as Array<{ hash?: string; expiresAt?: number }>
      const now = this.clock.now()
      for (const record of records) if (record.hash && Number.isFinite(record.expiresAt) && record.expiresAt > now) this.sessions.set(record.hash, { expiresAt: Number(record.expiresAt) })
    } catch { /* corrupt persistence is treated as an empty session set */ }
  }

  private persistSessions(): void {
    if (!this.persistencePath) return
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      writeFileSync(this.persistencePath, JSON.stringify([...this.sessions].map(([hash, value]) => ({ hash, expiresAt: value.expiresAt }))), 'utf8')
    } catch { /* authorization must keep working even if persistence is unavailable */ }
  }
}

export class RemoteAccessService {
  readonly policy: RemoteAccessPolicy

  constructor(options: RemoteAccessOptions = {}) {
    this.policy = new RemoteAccessPolicy(options)
  }

  get enabled(): boolean { return this.policy.enabled }
  get authenticateLoopback(): boolean { return this.policy.authenticateLoopback }
  createPairingCode(): PairingCode { return this.policy.createPairingCode() }
  revokeSession(token: string): boolean { return this.policy.revokeSession(token) }
  revokeAllSessions(): number { return this.policy.revokeAllSessions() }

  authorizeRequest(request: IncomingMessage): boolean {
    return this.policy.authorize(this.sessionToken(request))
  }

  /** 从请求中提取会话令牌：优先 Bearer，其次远程会话 Cookie（浏览器直连）。 */
  sessionToken(request: IncomingMessage): string | undefined {
    const header = request.headers.authorization
    const bearer = typeof header === 'string' ? header.match(/^Bearer\s+([^\s]+)$/i)?.[1] : undefined
    if (bearer) return bearer
    const cookie = request.headers.cookie
    if (typeof cookie !== 'string' || !cookie) return undefined
    for (const part of cookie.split(';')) {
      const separator = part.indexOf('=')
      if (separator <= 0) continue
      const name = part.slice(0, separator).trim()
      if (name === REMOTE_SESSION_COOKIE) return part.slice(separator + 1).trim() || undefined
    }
    return undefined
  }

  async handlePairing(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/api/remote/pairing-code') {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        this.send(response, 404, { error: 'Not found.' })
        return true
      }
      if (!this.enabled || request.method !== 'POST') {
        console.log(`[remote] pairing-code denied from ${request.socket.remoteAddress} (enabled=${this.enabled})`)
        this.send(response, 403, { error: 'Operator request denied.' })
        return true
      }
      const pairing = this.createPairingCode()
      console.log(`[remote] pairing-code issued from ${request.socket.remoteAddress}: ${pairing.code}`)
      this.send(response, 200, pairing)
      return true
    }
    if (url.pathname === '/api/remote/device-token') {
      // ADB reverse 免码直连：只有本机回环（= 已授权 adb 设备的 reverse 隧道）能拿到会话 token，
      // 等价于配对码只对局域网第三方保密、对本机回环不设防的既有信任模型。
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        this.send(response, 404, { error: 'Not found.' })
        return true
      }
      if (!this.enabled || request.method !== 'POST') {
        console.log(`[remote] device-token denied from ${request.socket.remoteAddress} (enabled=${this.enabled})`)
        this.send(response, 403, { error: 'Operator request denied.' })
        return true
      }
      const session = this.policy.createTrustedSession()
      console.log(`[remote] device-token issued from ${request.socket.remoteAddress}`)
      this.send(response, 200, { token: session.token, expiresAt: session.expiresAt })
      return true
    }
    if (url.pathname !== '/api/remote/pair') return false
    if (!this.enabled) {
      console.log(`[remote] pair denied from ${request.socket.remoteAddress}: remote access disabled`)
      this.send(response, 403, { error: 'Remote access disabled.' })
      return true
    }
    if (request.method !== 'POST') {
      this.send(response, 403, { error: 'Pairing request denied.' })
      return true
    }
    let body: Record<string, unknown>
    try { body = await this.readJson(request) } catch { this.send(response, 401, { error: 'Pairing failed.' }); return true }
    const clientKey = request.socket.remoteAddress ?? 'unknown'
    const result = this.policy.exchangePairingCode(String(body.code ?? ''), clientKey)
    console.log(`[remote] pair from ${request.socket.remoteAddress}: ${result.ok ? 'ok' : result.status}`)
    if (result.ok) {
      // 浏览器直连：下发 HttpOnly 会话 Cookie，之后对 /api、/assets、/story-assets 的所有请求自动携带。
      // SameSite=Lax：跨站子资源（如他人网页 <img>）不带 Cookie；POST/JSON 跨站更不携带。
      response.setHeader('Set-Cookie', `${REMOTE_SESSION_COOKIE}=${result.session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.ceil(this.policy.sessionTtlMs / 1_000))}`)
      this.send(response, 200, { token: result.session.token, expiresAt: result.session.expiresAt })
    }
    else if (result.status === 'limited') this.send(response, 429, { error: 'Pairing temporarily unavailable.' })
    else if (result.status === 'disabled') this.send(response, 403, { error: 'Remote access disabled.' })
    else this.send(response, 401, { error: 'Pairing failed.' })
    return true
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 4_096) throw new Error('Pairing request is too large.')
      chunks.push(buffer)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pairing request must be an object.')
    return value as Record<string, unknown>
  }

  private send(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
}

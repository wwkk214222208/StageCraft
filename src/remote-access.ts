import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
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
  private readonly sessionTtlMs: number
  private readonly maxPairingFailures: number
  private readonly failureWindowMs: number
  private readonly blockMs: number
  private readonly clock: { now(): number }
  private readonly random: (size: number) => Uint8Array
  private readonly pairingCodes = new Map<string, ExpiringHash>()
  private readonly sessions = new Map<string, ExpiringHash>()
  private readonly failures = new Map<string, FailureState>()

  constructor(options: RemoteAccessOptions = {}) {
    this.enabled = options.enabled === true
    this.authenticateLoopback = options.authenticateLoopback === true
    this.pairingTtlMs = Math.max(1_000, options.pairingTtlMs ?? 5 * 60_000)
    this.sessionTtlMs = Math.max(1_000, options.sessionTtlMs ?? 12 * 60 * 60_000)
    this.maxPairingFailures = Math.max(1, options.maxPairingFailures ?? 5)
    this.failureWindowMs = Math.max(1_000, options.failureWindowMs ?? 60_000)
    this.blockMs = Math.max(1_000, options.blockMs ?? 60_000)
    this.clock = options.clock ?? Date
    this.random = options.randomBytes ?? (size => nodeRandomBytes(size))
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
    let token: string | undefined
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = Buffer.from(this.random(32)).toString('base64url')
      if (!this.sessions.has(hashSecret(candidate))) { token = candidate; break }
    }
    if (!token) throw new Error('Unable to generate a unique remote session.')
    const expiresAt = now + this.sessionTtlMs
    this.sessions.set(hashSecret(token), { expiresAt })
    return { ok: true, session: { token, expiresAt } }
  }

  authorize(token: string | undefined): boolean {
    if (!this.enabled || !token) return false
    const now = this.clock.now()
    const session = this.sessions.get(hashSecret(token))
    if (!session || session.expiresAt <= now) {
      if (session) this.sessions.delete(hashSecret(token))
      return false
    }
    return true
  }

  revokeSession(token: string): boolean {
    return this.sessions.delete(hashSecret(token))
  }

  /** 吊销全部会话（本机操作员应急 / 清除所有已配对手机）。 */
  revokeAllSessions(): number {
    const count = this.sessions.size
    this.sessions.clear()
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
    const header = request.headers.authorization
    const match = typeof header === 'string' ? header.match(/^Bearer\s+([^\s]+)$/i) : undefined
    return this.policy.authorize(match?.[1])
  }

  async handlePairing(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/api/remote/pairing-code') {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        this.send(response, 404, { error: 'Not found.' })
        return true
      }
      if (!this.enabled || request.method !== 'POST') {
        this.send(response, 403, { error: 'Operator request denied.' })
        return true
      }
      const pairing = this.createPairingCode()
      this.send(response, 200, pairing)
      return true
    }
    if (url.pathname !== '/api/remote/pair') return false
    if (!this.enabled) {
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
    if (result.ok) this.send(response, 200, { token: result.session.token, expiresAt: result.session.expiresAt })
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

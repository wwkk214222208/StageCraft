import { assertUiJsonSafe, type UiActionDefinition } from './ui.ts'
import type { CoreView } from './protocol.ts'

export type LegacyRpcPrimitive = string | number | boolean | null
type LegacyRpcValue = LegacyRpcPrimitive | LegacyRpcValue[] | { [key: string]: LegacyRpcValue }

export interface LegacySandboxDescriptor {
  id: string
  owner: string
  version: string
  assetId: string
  actions?: UiActionDefinition[]
}

export interface LegacyRpcRequest {
  id: string
  method: 'getView' | 'invokeAction'
  params?: LegacyRpcValue
}

export interface LegacyRpcResponse {
  id: string
  ok: boolean
  result?: LegacyRpcValue
  error?: { code: 'invalid_request' | 'forbidden' | 'not_found' | 'closed' | 'internal'; message: string }
}

export interface LegacySandboxHost {
  getView(): CoreView
  invokeUiAction(actionId: string, input: unknown, owner: string): Promise<unknown>
}

const MAX_RPC_BYTES = 64 * 1024
const MAX_ID_LENGTH = 128
const forbiddenMethods = new Set(['eval', 'fetch', 'XMLHttpRequest', 'readFile', 'native', 'getSecrets', 'getCookies', 'getDom'])

function cloneJson<T>(value: T, label: string): T {
  assertUiJsonSafe(value, label)
  return structuredClone(value)
}

function response(id: string, value: unknown): LegacyRpcResponse {
  return { id, ok: true, result: cloneJson(value, 'Legacy RPC result') as LegacyRpcValue }
}

function failure(id: string, code: LegacyRpcResponse['error']['code'], message: string): LegacyRpcResponse {
  return { id, ok: false, error: { code, message } }
}

function requestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && /^[A-Za-z0-9._:-]+$/.test(value)
}

/**
 * Host-side protocol endpoint for legacy card UI. It never receives a DOM,
 * platform object, secret, cookie, file handle, or network capability.
 */
export class LegacySandboxSession {
  private closed = false
  private readonly actions: ReadonlySet<string>

  readonly descriptor: LegacySandboxDescriptor
  private readonly host: LegacySandboxHost

  constructor(descriptor: LegacySandboxDescriptor, host: LegacySandboxHost) {
    this.descriptor = descriptor
    this.host = host
    if (!descriptor.id || !descriptor.owner || !descriptor.version || !descriptor.assetId) throw new Error('Legacy sandbox descriptor is incomplete.')
    this.actions = new Set((descriptor.actions ?? []).map(action => action.id))
    if (this.actions.size !== (descriptor.actions ?? []).length) throw new Error('Legacy sandbox actions must be unique.')
  }

  async handle(raw: string): Promise<string> {
    let id = 'unknown'
    try {
      if (this.closed) return JSON.stringify(failure(id, 'closed', 'Legacy sandbox is closed.'))
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_RPC_BYTES) return JSON.stringify(failure(id, 'invalid_request', 'RPC message is too large.'))
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { return JSON.stringify(failure('unknown', 'invalid_request', 'RPC request must be valid JSON.')) }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return JSON.stringify(failure(id, 'invalid_request', 'RPC request must be an object.'))
      const request = parsed as Record<string, unknown>
      id = request.id as string
      if (!requestId(request.id)) return JSON.stringify(failure('unknown', 'invalid_request', 'RPC request id is invalid.'))
      if (typeof request.method !== 'string' || forbiddenMethods.has(request.method) || !['getView', 'invokeAction'].includes(request.method)) return JSON.stringify(failure(request.id, 'forbidden', 'RPC method is not allowlisted.'))
      if (request.method === 'getView') {
        if (request.params !== undefined) return JSON.stringify(failure(request.id, 'invalid_request', 'getView does not accept parameters.'))
        return JSON.stringify(response(request.id, this.host.getView()))
      }
      const params = request.params
      if (!params || typeof params !== 'object' || Array.isArray(params) || typeof (params as any).actionId !== 'string') return JSON.stringify(failure(request.id, 'invalid_request', 'invokeAction requires actionId and input.'))
      const actionId = (params as any).actionId
      if (!this.actions.has(actionId)) return JSON.stringify(failure(request.id, 'not_found', 'Legacy action is not allowlisted.'))
      if (!Object.prototype.hasOwnProperty.call(params, 'input')) return JSON.stringify(failure(request.id, 'invalid_request', 'invokeAction requires input.'))
      const input = cloneJson((params as any).input, 'Legacy RPC input')
      return JSON.stringify(response(request.id, await this.host.invokeUiAction(actionId, input, this.descriptor.owner)))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Legacy RPC failed.'
      return JSON.stringify(failure(requestId(id) ? id : 'unknown', this.closed ? 'closed' : 'internal', message))
    }
  }

  close(): void { this.closed = true }
  get isClosed(): boolean { return this.closed }
}

export function legacySandboxCsp(): string {
  return "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
}

export function isLegacySandboxAssetUrl(url: string, assetId: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'appassets.androidplatform.net' && parsed.username === '' && parsed.password === '' && parsed.pathname.startsWith(`/legacy/${encodeURIComponent(assetId)}/`) && !parsed.pathname.includes('..')
  } catch { return false }
}

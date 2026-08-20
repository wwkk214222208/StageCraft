import type { CoreEvent, CoreView } from '../core/protocol.ts'

/** Version negotiated by the DSH supervisor and the StageCraft worker. */
export const DEBUG_SANDBOX_PROTOCOL_VERSION = '1.0'
export const DEBUG_SANDBOX_PROTOCOL_NAME = 'stagecraft.debug-sandbox'

export const DEBUG_SANDBOX_LIMITS = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxStringLength: 64 * 1024,
  maxArrayLength: 1024,
  maxObjectKeys: 256,
  maxDepth: 16,
  maxBatchItems: 128,
})

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type DebugCapability =
  | 'debug.read'
  | 'debug.control'
  | 'debug.reload'
  | 'debug.inspect'
  | 'debug.stream'

export interface DebugOwner {
  ownerId: string
  sessionId: string
  capabilities: readonly DebugCapability[]
}

export type WorkerStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'restarting'

export interface WorkerStatusSnapshot {
  status: WorkerStatus
  generation: number
  pid?: number
  reason?: string
  changedAt: string
}

export type DebugRpcMethod =
  | 'worker.status'
  | 'worker.stop'
  | 'worker.kill'
  | 'worker.restart'
  | 'worker.recover'
  | 'fiber.reload'
  | 'core.view.get'
  | 'debug.subscribe'
  | 'inspector.endpoint.get'

export interface DebugRpcParams {
  'worker.status': Record<string, never>
  'worker.stop': { reason?: string }
  'worker.kill': { reason?: string }
  'worker.restart': { reason?: string }
  'worker.recover': { reason?: string }
  'fiber.reload': { fiberId: string }
  'core.view.get': { revision?: number }
  'debug.subscribe': { streams: readonly DebugStream[] }
  'inspector.endpoint.get': Record<string, never>
}

export interface DebugRpcResults {
  'worker.status': WorkerStatusSnapshot
  'worker.stop': WorkerStatusSnapshot
  'worker.kill': WorkerStatusSnapshot
  'worker.restart': WorkerStatusSnapshot
  'worker.recover': WorkerStatusSnapshot
  'fiber.reload': { fiberId: string; reloaded: true; generation: number }
  'core.view.get': CoreView
  'debug.subscribe': { streams: readonly DebugStream[]; subscribed: true }
  'inspector.endpoint.get': InspectorEndpoint | null
}

export type DebugStream = 'logs' | 'worker.status' | 'core.view' | 'core.event'

export interface WorkerRequest<M extends DebugRpcMethod = DebugRpcMethod> {
  protocol: typeof DEBUG_SANDBOX_PROTOCOL_VERSION
  kind: 'request'
  requestId: string
  owner: DebugOwner
  method: M
  params: DebugRpcParams[M]
  deadlineAt?: string
}

export interface WorkerResponse<M extends DebugRpcMethod = DebugRpcMethod> {
  protocol: typeof DEBUG_SANDBOX_PROTOCOL_VERSION
  kind: 'response'
  requestId: string
  owner: Pick<DebugOwner, 'ownerId' | 'sessionId'>
  method: M
  ok: boolean
  result?: DebugRpcResults[M]
  error?: DebugRpcError
}

export interface DebugRpcError {
  code: 'invalid-request' | 'unsupported-version' | 'unauthorized' | 'not-found' | 'cancelled' | 'busy' | 'worker-failed' | 'internal'
  message: string
  retryable?: boolean
}

export interface RequestCancellation {
  protocol: typeof DEBUG_SANDBOX_PROTOCOL_VERSION
  kind: 'cancel'
  requestId: string
  owner: Pick<DebugOwner, 'ownerId' | 'sessionId'>
  reason?: string
}

export interface StructuredLog {
  level: 'debug' | 'info' | 'warn' | 'error'
  timestamp: string
  message: string
  requestId?: string
  ownerId?: string
  sessionId?: string
  fields?: Record<string, JsonValue>
}

export interface CoreViewStreamEnvelope {
  protocol: typeof DEBUG_SANDBOX_PROTOCOL_VERSION
  kind: 'stream'
  stream: 'core.view'
  sequence: number
  revision: number
  view: CoreView
}

export interface CoreEventStreamEnvelope {
  protocol: typeof DEBUG_SANDBOX_PROTOCOL_VERSION
  kind: 'stream'
  stream: 'core.event'
  sequence: number
  revision: number
  event: CoreEvent
}

export interface LogStreamEnvelope {
  protocol: typeof DEBUG_SANDBOX_PROTOCOL_VERSION
  kind: 'stream'
  stream: 'logs'
  sequence: number
  log: StructuredLog
}

export interface WorkerStatusStreamEnvelope {
  protocol: typeof DEBUG_SANDBOX_PROTOCOL_VERSION
  kind: 'stream'
  stream: 'worker.status'
  sequence: number
  status: WorkerStatusSnapshot
}

export type DebugStreamEnvelope = CoreViewStreamEnvelope | CoreEventStreamEnvelope | LogStreamEnvelope | WorkerStatusStreamEnvelope

export interface InspectorEndpoint {
  host: '127.0.0.1' | '::1'
  port: number
  token: string
  expiresAt: string
}

export interface DebugRpc {
  request<M extends DebugRpcMethod>(request: WorkerRequest<M>, signal?: AbortSignal): Promise<WorkerResponse<M>>
  cancel(cancellation: RequestCancellation): Promise<void>
  subscribe(streams: readonly DebugStream[], listener: (envelope: DebugStreamEnvelope) => void): () => void
  shutdown(reason?: string): Promise<void>
  restart(reason?: string): Promise<WorkerStatusSnapshot>
  recover(reason?: string): Promise<WorkerStatusSnapshot>
  reloadFiber(fiberId: string): Promise<DebugRpcResults['fiber.reload']>
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} is invalid.`)
}

function date(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`)
}

/** Validate JSON and enforce frame-safe recursive bounds before transport. */
export function assertBoundedJson(value: unknown, label = 'value', depth = 0): asserts value is JsonValue {
  if (depth > DEBUG_SANDBOX_LIMITS.maxDepth) throw new Error(`${label} exceeds maximum JSON depth.`)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`)
    return
  }
  if (typeof value === 'string') {
    if (value.length > DEBUG_SANDBOX_LIMITS.maxStringLength) throw new Error(`${label} exceeds maximum string length.`)
    return
  }
  if (Array.isArray(value)) {
    if (value.length > DEBUG_SANDBOX_LIMITS.maxArrayLength) throw new Error(`${label} exceeds maximum array length.`)
    value.forEach((item, index) => assertBoundedJson(item, `${label}[${index}]`, depth + 1))
    return
  }
  if (typeof value !== 'object') throw new Error(`${label} is not JSON.`)
  const keys = Object.keys(value)
  if (keys.length > DEBUG_SANDBOX_LIMITS.maxObjectKeys) throw new Error(`${label} exceeds maximum object key count.`)
  for (const key of keys) {
    if (key.length > 256) throw new Error(`${label} contains an oversized key.`)
    assertBoundedJson((value as Record<string, unknown>)[key], `${label}.${key}`, depth + 1)
  }
  const bytes = Buffer.byteLength(JSON.stringify(value))
  if (bytes > DEBUG_SANDBOX_LIMITS.maxFrameBytes) throw new Error(`${label} exceeds maximum frame size.`)
}

export function validateOwner(owner: DebugOwner): void {
  const value = record(owner, 'owner')
  id(value.ownerId, 'owner.ownerId'); id(value.sessionId, 'owner.sessionId')
  if (!Array.isArray(value.capabilities) || value.capabilities.some(capability => !['debug.read', 'debug.control', 'debug.reload', 'debug.inspect', 'debug.stream'].includes(String(capability)))) throw new Error('owner.capabilities is invalid.')
}

export function validateWorkerRequest(request: WorkerRequest): void {
  const value = record(request, 'worker request')
  if (value.protocol !== DEBUG_SANDBOX_PROTOCOL_VERSION) throw new Error('Unsupported sandbox protocol version.')
  if (value.kind !== 'request') throw new Error('Worker request kind is invalid.')
  id(value.requestId, 'requestId'); validateOwner(value.owner as DebugOwner)
  if (!['worker.status', 'worker.stop', 'worker.kill', 'worker.restart', 'worker.recover', 'fiber.reload', 'core.view.get', 'debug.subscribe', 'inspector.endpoint.get'].includes(String(value.method))) throw new Error('Worker request method is invalid.')
  assertBoundedJson(value.params, 'request.params')
  if (value.deadlineAt !== undefined) date(value.deadlineAt, 'request.deadlineAt')
  assertBoundedJson(value, 'worker request')
}

export function validateWorkerResponse(response: WorkerResponse): void {
  const value = record(response, 'worker response')
  if (value.protocol !== DEBUG_SANDBOX_PROTOCOL_VERSION) throw new Error('Unsupported sandbox protocol version.')
  if (value.kind !== 'response') throw new Error('Worker response kind is invalid.')
  id(value.requestId, 'response.requestId')
  const owner = record(value.owner, 'response.owner'); id(owner.ownerId, 'response.owner.ownerId'); id(owner.sessionId, 'response.owner.sessionId')
  if (typeof value.ok !== 'boolean') throw new Error('response.ok is required.')
  if (value.ok === (value.result === undefined)) throw new Error('Response must contain exactly one result or error.')
  if (!value.ok) record(value.error, 'response.error')
  assertBoundedJson(value, 'worker response')
}

export function validateCancellation(cancellation: RequestCancellation): void {
  const value = record(cancellation, 'cancellation')
  if (value.protocol !== DEBUG_SANDBOX_PROTOCOL_VERSION || value.kind !== 'cancel') throw new Error('Cancellation envelope is invalid.')
  id(value.requestId, 'cancellation.requestId'); const owner = record(value.owner, 'cancellation.owner'); id(owner.ownerId, 'cancellation.owner.ownerId'); id(owner.sessionId, 'cancellation.owner.sessionId')
  if (value.reason !== undefined && typeof value.reason !== 'string') throw new Error('Cancellation reason is invalid.')
  assertBoundedJson(value, 'cancellation')
}

export function authorizeDebugRpc(owner: DebugOwner, method: DebugRpcMethod): void {
  validateOwner(owner)
  const required: DebugCapability = method === 'inspector.endpoint.get' ? 'debug.inspect' : method === 'debug.subscribe' ? 'debug.stream' : method === 'fiber.reload' ? 'debug.reload' : method === 'worker.status' || method === 'core.view.get' ? 'debug.read' : 'debug.control'
  if (!owner.capabilities.includes(required)) throw new Error(`Capability ${required} is required for ${method}.`)
}

export function validateInspectorEndpoint(endpoint: InspectorEndpoint): void {
  if (endpoint.host !== '127.0.0.1' && endpoint.host !== '::1') throw new Error('Inspector must bind to loopback.')
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error('Inspector port is invalid.')
  if (!endpoint.token || endpoint.token.length > 256) throw new Error('Inspector token is invalid.')
  date(endpoint.expiresAt, 'Inspector expiry')
}

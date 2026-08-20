import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEBUG_SANDBOX_LIMITS,
  DEBUG_SANDBOX_PROTOCOL_VERSION,
  assertBoundedJson,
  authorizeDebugRpc,
  validateCancellation,
  validateInspectorEndpoint,
  validateWorkerRequest,
  validateWorkerResponse,
  type DebugOwner,
  type RequestCancellation,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/debug/sandbox-protocol.ts'

const owner: DebugOwner = { ownerId: 'dsh-host', sessionId: 'session-1', capabilities: ['debug.read', 'debug.control', 'debug.reload', 'debug.stream'] }

function request<M extends WorkerRequest['method']>(method: M, params: WorkerRequest<M>['params']): WorkerRequest<M> {
  return { protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'request', requestId: 'request-1', owner, method, params }
}

test('sandbox request and response contracts are versioned, identified, and bounded', () => {
  const value = request('worker.status', {})
  validateWorkerRequest(value)
  const response: WorkerResponse<'worker.status'> = { protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'response', requestId: value.requestId, owner, method: value.method, ok: true, result: { status: 'running', generation: 1, changedAt: '2026-01-01T00:00:00Z' } }
  validateWorkerResponse(response)
  assert.throws(() => validateWorkerRequest({ ...value, protocol: '9.0' }), /Unsupported sandbox protocol/)
  assert.throws(() => validateWorkerResponse({ ...response, ok: true, result: undefined, error: undefined }), /exactly one/)
})

test('bounded JSON rejects deep, wide, oversized, and non-JSON values', () => {
  assertBoundedJson({ ok: ['synthetic'] })
  assert.throws(() => assertBoundedJson('x'.repeat(DEBUG_SANDBOX_LIMITS.maxStringLength + 1)), /maximum string/)
  assert.throws(() => assertBoundedJson(Array.from({ length: DEBUG_SANDBOX_LIMITS.maxArrayLength + 1 }, () => null)), /maximum array/)
  assert.throws(() => assertBoundedJson({ value: Number.NaN }), /non-finite/)
  assert.throws(() => assertBoundedJson(undefined), /not JSON/)
})

test('owner capability rules authorize reads and protect control operations', () => {
  authorizeDebugRpc(owner, 'core.view.get')
  authorizeDebugRpc(owner, 'fiber.reload')
  assert.throws(() => authorizeDebugRpc({ ...owner, capabilities: ['debug.read'] }, 'worker.stop'), /debug.control/)
  assert.throws(() => authorizeDebugRpc(owner, 'inspector.endpoint.get'), /debug.inspect/)
})

test('cancellation is request-scoped and inspector is loopback-only', () => {
  const cancellation: RequestCancellation = { protocol: DEBUG_SANDBOX_PROTOCOL_VERSION, kind: 'cancel', requestId: 'request-1', owner: { ownerId: owner.ownerId, sessionId: owner.sessionId }, reason: 'test' }
  validateCancellation(cancellation)
  validateInspectorEndpoint({ host: '127.0.0.1', port: 9229, token: 'synthetic-token', expiresAt: '2026-01-01T00:00:00Z' })
  assert.throws(() => validateInspectorEndpoint({ host: '0.0.0.0' as '127.0.0.1', port: 9229, token: 'token', expiresAt: '2026-01-01T00:00:00Z' }), /loopback/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteAccessPolicy } from '../src/remote-access.ts'

function deterministicRandom() {
  let seed = 0
  return (size: number): Uint8Array => Uint8Array.from({ length: size }, () => seed++ % 251)
}

test('remote pairing is one-time, expiring, rate-limited and revocable', () => {
  let now = 10_000
  const disabled = new RemoteAccessPolicy({ clock: { now: () => now }, randomBytes: deterministicRandom() })
  assert.throws(() => disabled.createPairingCode(), /disabled/)
  assert.deepEqual(disabled.exchangePairingCode('anything', 'client'), { ok: false, status: 'disabled' })

  const policy = new RemoteAccessPolicy({
    enabled: true, pairingTtlMs: 1_000, sessionTtlMs: 1_000, maxPairingFailures: 2, failureWindowMs: 1_000, blockMs: 1_000,
    clock: { now: () => now }, randomBytes: deterministicRandom(),
  })
  const first = policy.createPairingCode()
  assert.equal(policy.exchangePairingCode('wrong', 'limited-client').status, 'invalid')
  assert.equal(policy.exchangePairingCode('wrong-again', 'limited-client').status, 'limited')
  assert.equal(policy.exchangePairingCode(first.code, 'limited-client').status, 'limited')
  now += 1_001
  const exchanged = policy.exchangePairingCode(first.code, 'limited-client')
  assert.equal(exchanged.ok, false) // pairing code expired during the block

  const second = policy.createPairingCode()
  const success = policy.exchangePairingCode(second.code, 'client')
  assert.equal(success.ok, true)
  if (!success.ok) return
  assert.ok(success.session.token.length >= 40)
  assert.equal(policy.authorize(success.session.token), true)
  assert.equal(policy.exchangePairingCode(second.code, 'client').status, 'invalid')
  assert.equal(policy.revokeSession(success.session.token), true)
  assert.equal(policy.authorize(success.session.token), false)

  const third = policy.createPairingCode()
  const expiring = policy.exchangePairingCode(third.code, 'other-client')
  assert.equal(expiring.ok, true)
  if (!expiring.ok) return
  now += 1_001
  assert.equal(policy.authorize(expiring.session.token), false)
})

test('pairing and session collisions fail closed instead of replacing credentials', () => {
  const fixed = new RemoteAccessPolicy({ enabled: true, randomBytes: size => new Uint8Array(size) })
  fixed.createPairingCode()
  assert.throws(() => fixed.createPairingCode(), /unique pairing code/)

  const eightByteValues = [0, 1]
  const collidingTokens = new RemoteAccessPolicy({
    enabled: true,
    randomBytes: size => size === 8 ? new Uint8Array(size).fill(eightByteValues.shift() ?? 1) : new Uint8Array(size).fill(7),
  })
  const firstCode = collidingTokens.createPairingCode()
  assert.equal(collidingTokens.exchangePairingCode(firstCode.code, 'first').ok, true)
  const secondCode = collidingTokens.createPairingCode()
  assert.throws(() => collidingTokens.exchangePairingCode(secondCode.code, 'second'), /unique remote session/)
})

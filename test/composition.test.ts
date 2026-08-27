import test from 'node:test'
import assert from 'node:assert/strict'
import { createPortableComposition, type NativeOperations } from '../src/platform/composition.ts'
import type { CoreStateCommit } from '../src/core/state-repository.ts'

test('portable composition forwards native assets and secrets without leaking references', async () => {
  const calls: Array<{ operation: string; input?: Record<string, unknown> }> = []
  const values = new Map<string, string>()
  const operations: NativeOperations = {
    invoke(operation, input) {
      calls.push({ operation, input })
      if (operation === 'asset.read') return { data: btoa('png') }
      if (operation === 'secret.get') return { value: values.get(String(input?.key)) }
      if (operation === 'secret.set') { values.set(String(input?.key), String(input?.value)); return undefined }
      if (operation === 'secret.remove') { values.delete(String(input?.key)); return undefined }
      return undefined
    },
  }
  const composition = createPortableComposition(operations)
  assert.deepEqual([...(await composition.assets.read('portrait.png')) ?? []], [...new TextEncoder().encode('png')])
  await composition.secrets.set('provider', 'token')
  assert.equal(await composition.secrets.get('provider'), 'token')
  await composition.secrets.remove('provider')
  assert.equal(await composition.secrets.get('provider'), undefined)
  assert.equal(calls[0]?.operation, 'asset.read')
})

test('portable composition keeps core state commit and restore synchronous', () => {
  let committed: CoreStateCommit | undefined
  const operations: NativeOperations = {
    invoke(operation, input) {
      if (operation === 'core-state.commit') { committed = input as unknown as CoreStateCommit; return undefined }
      if (operation === 'core-state.restore') return committed
      return undefined
    },
  }
  const repository = createPortableComposition(operations).state
  const snapshot: CoreStateCommit = { roomId: 'room', revision: 2, state: { room: {} }, events: [], workflows: [] }
  repository.commit(snapshot)
  assert.deepEqual(repository.restore('room'), snapshot)
})

test('portable composition parses native story sources and transports model requests', async () => {
  const operations: NativeOperations = {
    invoke(operation) {
      if (operation === 'story.read') return JSON.stringify({ id: 'story', title: 'Story', opening: 'Open', playerCharacter: { name: 'P', persona: 'P', currentState: 'P' }, roles: [] })
      if (operation === 'model.request') return { requestId: 'request', output: { ok: true } }
      return undefined
    },
  }
  const composition = createPortableComposition(operations)
  assert.equal((await composition.sources.story('story')).id, 'story')
  const result = await composition.model.request({ requestId: 'request', capability: 'test', prompt: { system: '', user: '' }, contract: { id: 'test', version: '1', schema: {} } })
  assert.deepEqual(result.output, { ok: true })
})

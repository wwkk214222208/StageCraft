import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeCoreStateRepository } from '../src/platform/composition.ts'

 test('Android-shaped synchronous bridge preserves command state and event/workflow snapshots', () => {
  let committed: any
  const calls: string[] = []
  const operations = {
    invokeSync(operation: string, input: any) {
      calls.push(operation)
      if (operation === 'core-state.commit') { committed = structuredClone(input); return { ok: true } }
      if (operation === 'core-state.restore') return committed
      throw new Error(`unexpected operation ${operation}`)
    },
    invoke() { throw new Error('async bridge not used for state') },
  }
  const repository = new NativeCoreStateRepository(operations)
  const snapshot = { roomId: 'android-local-room', revision: 4, state: { phase: 'drafting', commandId: 'cmd-1' }, events: [{ type: 'state.changed', revision: 4, state: { phase: 'drafting' } }], workflows: [{ id: 'workflow-1', status: 'running' }] } as any
  repository.commit(snapshot)
  assert.deepEqual(repository.restore(snapshot.roomId), snapshot)
  assert.deepEqual(calls, ['core-state.commit', 'core-state.restore'])
})

test('Android bridge errors remain errors instead of becoming empty JSON objects', () => {
  const operations = { invokeSync: () => { throw new Error('Invalid asset path.') } } as any
  const repository = new NativeCoreStateRepository(operations)
  assert.throws(() => repository.commit({ roomId: 'r', revision: 0, state: {}, events: [], workflows: [] }), /Invalid asset path/)
})

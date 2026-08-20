import assert from 'node:assert/strict'
import test from 'node:test'
import { createCordisContext } from '../src/cordis-runtime.ts'
import { dshStoryBridgeCordisPlugin, dshStoryTaskIds } from '../src/dsh-story-bridge.ts'

function stagecraft() {
  const handlers = new Map<string, { handle(input: unknown): unknown }>()
  return {
    extensions: {
      registerEffectHandler(definition: { id: string; handle(input: unknown): unknown }) {
        handlers.set(definition.id, definition)
        return { dispose: () => { handlers.delete(definition.id) } }
      },
      invokeEffect(id: string, input: unknown) {
        const handler = handlers.get(id)
        if (!handler) throw new Error(`missing ${id}`)
        return handler.handle(input)
      },
    },
    handlers,
  }
}

async function installPresent(fake: { agents: unknown; llm: unknown; approval: unknown }) {
  const ctx = createCordisContext()
  const core = stagecraft()
  ctx.provide('stagecraft', core)
  ctx.provide('agents', fake.agents)
  ctx.provide('llm', fake.llm)
  ctx.provide('approval', fake.approval)
  const fiber = ctx.plugin(dshStoryBridgeCordisPlugin({ owner: 'test-owner' }))
  await fiber
  return { ctx, core, fiber }
}

test('DSH bridge is absent-service safe and does not register task handlers', async () => {
  const ctx = createCordisContext()
  const core = stagecraft()
  ctx.provide('stagecraft', core)
  const fiber = ctx.plugin(dshStoryBridgeCordisPlugin())
  await fiber
  assert.deepEqual([...core.handlers], [])
  await fiber.dispose()
})

test('DSH bridge registers all four tasks, approves, bounds, isolates, and returns preview', async () => {
  const seen: unknown[] = []
  const approval: { request: (input: unknown) => Promise<unknown> } = { request: async input => { seen.push({ approval: input }); return 'allowed-once' } }
  const agents = { runTask: async (input: unknown, signal: AbortSignal) => { assert.equal(signal.aborted, false); seen.push(input); return { preview: 'preview', suggestions: ['one', 2], privateContent: 'must not cross' } } }
  const installed = await installPresent({ agents, llm: {}, approval })
  assert.deepEqual([...installed.core.handlers.keys()], dshStoryTaskIds())
  const output = await installed.core.extensions.invokeEffect('dsh.story.generate', {
    owner: 'test-owner:session-1', title: 'Title', text: 'a'.repeat(20_000), privateMemory: 'PRIVATE',
    constraints: ['keep', 'bounded'], source: 'creator', extra: { secret: 'PRIVATE' },
  })
  assert.deepEqual(output, { task: 'story.generate', owner: 'test-owner:session-1', preview: 'preview', suggestions: ['one'] })
  const envelope = seen.find(item => typeof item === 'object' && item !== null && 'task' in item) as Record<string, unknown>
  assert.equal(envelope.privateMemory, undefined)
  assert.equal(envelope.extra, undefined)
  assert.equal((envelope.text as string).length, 12_000)
  await installed.fiber.dispose()
})

test('DSH bridge rejects foreign owners and does not invoke DSH', async () => {
  let calls = 0
  const installed = await installPresent({ agents: { runTask: async () => { calls += 1; return { preview: 'no' } } }, llm: {}, approval: { request: async () => 'allowed-once' } })
  await assert.rejects(installed.core.extensions.invokeEffect('dsh.story.polish', { owner: 'other:session', text: 'x' }), /owner/)
  assert.equal(calls, 0)
  await installed.fiber.dispose()
})

test('DSH bridge Fiber unload removes every task handler', async () => {
  const installed = await installPresent({ agents: { runTask: async () => ({ preview: 'ok' }) }, llm: {}, approval: { request: async () => 'allowed-once' } })
  assert.equal(installed.core.handlers.size, 4)
  await installed.fiber.dispose()
  assert.equal(installed.core.handlers.size, 0)
  assert.throws(() => installed.core.extensions.invokeEffect('dsh.story.consistency', { owner: 'test-owner:x' }), /missing/)
})

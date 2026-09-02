import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryAssetRepository, MemorySecretStore, type Clock } from '../src/core/platform.ts'
import { CoreRuntimeSkeleton } from '../src/core/runtime.ts'
import { NodeFileRepository, NodeSecretStore } from '../src/platform/node.ts'
import { NodeLlmStateStore } from '../src/platform/node-llm.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('portable memory ports copy bytes and isolate secrets', async () => {
  const assets = new MemoryAssetRepository()
  const source = new Uint8Array([1, 2, 3])
  await assets.write('portrait.bin', source)
  source[0] = 9
  const loaded = await assets.read('portrait.bin')
  assert.deepEqual([...loaded ?? []], [1, 2, 3])
  if (loaded) loaded[1] = 8
  assert.deepEqual([...(await assets.read('portrait.bin')) ?? []], [1, 2, 3])

  const secrets = new MemorySecretStore()
  await secrets.set('session', 'token')
  assert.equal(await secrets.get('session'), 'token')
  await secrets.remove('session')
  assert.equal(await secrets.get('session'), undefined)
})

test('node asset adapter is bounded to its root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stagecraft-assets-'))
  try {
    const assets = new NodeFileRepository(root)
    await assets.write('nested/a.bin', new Uint8Array([7]))
    assert.deepEqual([...(await assets.read('nested/a.bin')) ?? []], [7])
    await assert.rejects(() => assets.read('../outside.bin'), /escapes repository root/)
    await assets.remove('nested/a.bin')
    assert.equal(await assets.read('nested/a.bin'), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('node secret adapter persists values behind the SecretStore port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stagecraft-secrets-'))
  try {
    const first = new NodeSecretStore(join(root, 'secrets.json'))
    await first.set('provider', 'secret')
    const restored = new NodeSecretStore(join(root, 'secrets.json'))
    assert.equal(await restored.get('provider'), 'secret')
    await restored.remove('provider')
    assert.equal(await restored.get('provider'), undefined)
    await Promise.all(Array.from({ length: 12 }, (_, index) => restored.set(`parallel-${index}`, String(index))))
    const parallel = await Promise.all(Array.from({ length: 12 }, (_, index) => restored.get(`parallel-${index}`)))
    assert.deepEqual(parallel, Array.from({ length: 12 }, (_, index) => String(index)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('node LLM state adapter serializes concurrent read-modify-write operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stagecraft-llm-state-'))
  try {
    const state = new NodeLlmStateStore(join(root, 'state.json'))
    await Promise.all(Array.from({ length: 12 }, (_, index) => state.write(`key-${index}`, { index })))
    const values = await Promise.all(Array.from({ length: 12 }, (_, index) => state.read<{ index: number }>(`key-${index}`)))
    assert.deepEqual(values.map(value => value?.index), Array.from({ length: 12 }, (_, index) => index))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('core runtime uses deterministic platform clock and ids', () => {
  const clock: Clock = { now: () => '2030-01-01T00:00:00.000Z' }
  const core = new CoreRuntimeSkeleton({ clock, ids: { create: () => 'fixed-id' } })
  core.registerStateModule({ id: 'ext', version: '1' })
  core.registerProposalType({ id: 'change', moduleId: 'ext', path: '/proposals', validate: () => undefined, apply: () => [] })
  const proposal = core.operateProposal({ roomId: 'room', operation: 'create', typeId: 'change', input: {} }) as { id: string; createdAt: string }
  assert.equal(proposal.id, 'fixed-id')
  assert.equal(proposal.createdAt, '2030-01-01T00:00:00.000Z')
})

test('portable runtime and domain services keep Node adapters behind their ports', async () => {
  const portableFiles = [
    'src/core/runtime.ts',
    'src/core/state.ts',
    'src/core/state-transaction.ts',
    'src/core/platform.ts',
    'src/stagecraft-chat-service.ts',
    'src/stagecraft-director-service.ts',
    'src/stagecraft-management-service.ts',
  ]
  for (const file of portableFiles) {
    const source = await readFile(join(process.cwd(), file), 'utf8')
    assert.doesNotMatch(source, /(?:from|import\()\s*['\"]node:/, `${file} imports a Node-only module`)
  }
  for (const file of portableFiles.slice(4)) {
    const source = await readFile(join(process.cwd(), file), 'utf8')
    assert.doesNotMatch(source, /from\s+['\"]\.\/store\.ts['\"]/, `${file} imports the concrete Store`)
  }
})

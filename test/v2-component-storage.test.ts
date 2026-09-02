import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNodeFileComponentStorage, MAX_STORAGE_VALUE_BYTES } from '../src/v2/component-storage.ts'

test('desktop component storage round-trips every JSON value kind', async () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-v2-storage-'))
  try {
    const storage = createNodeFileComponentStorage(root)
    const caller = { pluginId: 'example.storage', version: '1.0.0' }
    const values: unknown[] = [{ nested: '值' }, ['数组', 2], '纯文本🙂', false, 17, null]
    for (const [index, value] of values.entries()) {
      await storage.write(caller, `area${index}`, value)
      assert.deepEqual(await storage.read(caller, `area${index}`), value)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('desktop component storage uses UTF-8 byte limits and returns complete reads', async () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-v2-storage-limit-'))
  try {
    const storage = createNodeFileComponentStorage(root)
    const caller = { pluginId: 'example.storage', version: '1.0.0' }
    const longText = '完整读取🙂'.repeat(5000)
    await storage.write(caller, 'large', longText)
    assert.equal(await storage.read(caller, 'large'), longText)
    await assert.rejects(() => storage.write(caller, 'too-large', '界'.repeat(Math.ceil(MAX_STORAGE_VALUE_BYTES / 3))), /bytes/)

    const file = join(root, caller.pluginId, 'oversized.json')
    mkdirSync(join(root, caller.pluginId), { recursive: true })
    writeFileSync(file, JSON.stringify('界'.repeat(Math.ceil(MAX_STORAGE_VALUE_BYTES / 3))))
    assert.equal(await storage.read(caller, 'oversized'), undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

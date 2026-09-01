import assert from 'node:assert/strict'
import test from 'node:test'
import { setupAdbReverse, type AdbReverseRunner } from '../src/platform/adb-reverse.ts'

test('setupAdbReverse creates a tunnel for every authorized device and reports per-device detail', async () => {
  const calls: Array<{ serial: string | null; port: number }> = []
  const runner: AdbReverseRunner = {
    async devices() { return ['DKS9K23407003495', 'emulator-5554'] },
    async reverse(serial, port) { calls.push({ serial, port }); return '' },
  }
  const result = await setupAdbReverse(8787, runner)
  assert.equal(result.ok, true)
  assert.deepEqual(result.devices, ['DKS9K23407003495', 'emulator-5554'])
  assert.deepEqual(calls, [
    { serial: 'DKS9K23407003495', port: 8787 },
    { serial: 'emulator-5554', port: 8787 },
  ])
  assert.equal(result.detail.length, 2)
  assert.match(result.detail[0], /DKS9K23407003495: 隧道已建立/)
})

test('setupAdbReverse fails closed when adb is unavailable', async () => {
  const runner: AdbReverseRunner = {
    async devices() { throw new Error('adb 命令未找到') },
    async reverse() { return '' },
  }
  const result = await setupAdbReverse(8787, runner)
  assert.equal(result.ok, false)
  assert.deepEqual(result.devices, [])
  assert.deepEqual(result.detail, ['adb 命令未找到'])
})

test('setupAdbReverse reports no-authorized-device and per-device failures without swallowing', async () => {
  const empty: AdbReverseRunner = {
    async devices() { return [] },
    async reverse() { return '' },
  }
  const noDevice = await setupAdbReverse(8787, empty)
  assert.equal(noDevice.ok, false)
  assert.match(noDevice.detail[0], /未检测到已授权的 adb 设备/)

  let failOnce = true
  const partial: AdbReverseRunner = {
    async devices() { return ['serial-a', 'serial-b'] },
    async reverse(serial) {
      if (serial === 'serial-a' && failOnce) { failOnce = false; throw new Error('reverse 被拒绝') }
      return ''
    },
  }
  const mixed = await setupAdbReverse(8787, partial)
  assert.equal(mixed.ok, false)
  assert.equal(mixed.detail.length, 2)
  assert.match(mixed.detail[0], /serial-a: reverse 被拒绝/)
  assert.match(mixed.detail[1], /serial-b: 隧道已建立/)
})

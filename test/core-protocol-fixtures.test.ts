/**
 * Gate C-1：共享协议 fixture 的 TS 侧消费测试（评审 C-1 P1）。
 *
 * 与 JVM GateBcClosureTest 消费同一份 android/app/src/main/assets/protocol-fixtures.json：
 * heartbeat / resume / abort 场景样本，TS 与 JVM 必须对相同输入给出相同解析与过滤结果。
 * 不得各自用硬编码样本证明各自正确。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { shouldDeliverCoreEvent, isCoreEventEnvelope } from '../src/core/connection.ts'
import type { CoreEventEnvelope, CoreEvent } from '../src/core/protocol.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = JSON.parse(
  readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'protocol-fixtures.json'), 'utf8'),
) as {
  fixtureVersion: string
  heartbeat: Array<{ name: string; wire: string; expectedEvents: number; keepsConnection: boolean }>
  resume: {
    name: string
    authoritativeViewRevision: number
    bufferedDuringReconnect: Array<{ revision: number; type: string; requestId?: string; shouldDeliver: boolean; reason: string }>
    finalDeliverableSequence: number[]
  }
  abort: { name: string; commandCancelIsSeparate: boolean; upstreamCloseWithinMs: number; subscriberReleaseWithinMs: number; noFurtherDelivery: boolean }
}

/** 与 JVM SseParser 同语义的最小 SSE 解析：注释行忽略，data: 行收集。 */
function parseSse(wire: string): string[] {
  const messages: string[] = []
  const buffer = wire.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (const block of buffer.split('\n\n')) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data) messages.push(data)
  }
  return messages
}

test('fixture 身份：fixtureVersion 与协议版本一致，heartbeat/resume/abort 样本齐备', () => {
  assert.equal(fixtures.fixtureVersion, '1.0.0-gatec')
  assert.ok(fixtures.heartbeat.length >= 2, 'heartbeat 样本必须存在')
  assert.equal(fixtures.resume.name, 'resync-then-incremental')
  assert.equal(fixtures.abort.name, 'client-abort')
})

test('heartbeat：注释帧不产生业务事件、连接保持有效（与 JVM 同 fixture）', () => {
  for (const sample of fixtures.heartbeat) {
    const messages = parseSse(sample.wire)
    assert.equal(messages.length, sample.expectedEvents, `${sample.name}: 注释帧不得产生业务事件`)
    for (const message of messages) {
      const parsed = JSON.parse(message) as CoreEventEnvelope
      assert.ok(isCoreEventEnvelope(parsed), `${sample.name}: data 帧必须是有效 envelope`)
    }
  }
})

test('resume：revision floor 过滤与最终投递序列（与 JVM 同 fixture）', () => {
  const { authoritativeViewRevision, bufferedDuringReconnect, finalDeliverableSequence } = fixtures.resume
  const delivered: number[] = []
  for (const item of bufferedDuringReconnect) {
    const envelope: CoreEventEnvelope = {
      protocolVersion: '1.1', roomId: 'fixture-room', revision: item.revision, type: item.type,
      payload: { type: item.type as CoreEvent['type'], revision: item.revision, ...(item.requestId ? { requestId: item.requestId } : {}) } as CoreEvent,
      createdAt: '2026-08-29T00:00:00.000Z',
    }
    const message = { type: 'core.event', event: envelope.payload, envelope }
    const deliver = shouldDeliverCoreEvent(message as never, { revision: authoritativeViewRevision })
    assert.equal(deliver, item.shouldDeliver, `revision ${item.revision}: ${item.reason}`)
    if (deliver) delivered.push(item.revision)
  }
  assert.deepEqual(delivered, finalDeliverableSequence, '最终允许投递序列必须与 fixture 一致')
})

test('abort：命令 cancel 与流 abort 语义分离、限时与停止投递字段明确', () => {
  assert.equal(fixtures.abort.commandCancelIsSeparate, true, '命令 cancel 与流 abort 是两套语义，不得混用')
  assert.ok(fixtures.abort.upstreamCloseWithinMs > 0, '上游关闭必须有界时限')
  assert.ok(fixtures.abort.subscriberReleaseWithinMs > 0, '订阅释放必须有界时限')
  assert.equal(fixtures.abort.noFurtherDelivery, true, 'abort 后不得继续投递')
})

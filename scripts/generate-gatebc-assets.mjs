#!/usr/bin/env node
/**
 * Gate B/C 收口资产生成器：
 *  - native-operation-registry.json ：Java 分派层 allowlist 执行依据（Gate B）
 *  - protocol-fixtures.json        ：TS 协议实现的黄金样本，JVM 侧逐条对等断言（Gate C）
 * 用法：node --experimental-strip-types scripts/generate-gatebc-assets.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NATIVE_OPERATIONS } from '../src/native-operation-registry.ts'
import { CORE_PROTOCOL_VERSION, MAX_SUPPORTED_PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, supportsProtocolVersion } from '../src/core/protocol.ts'

const NL = String.fromCharCode(10)
const NL2 = String.fromCharCode(10, 10)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const byOwner = owner => NATIVE_OPERATIONS.filter(op => op.owner === owner).map(op => op.name)
const nativeRegistry = {
  registryVersion: '1.0.0-gateb',
  mainHost: byOwner('main-host'),
  coreNative: byOwner('core-native'),
  legacyMainCoreException: NATIVE_OPERATIONS
    .filter(op => op.legacyExposure === 'legacy-main-core' && op.owner === 'core-native')
    .map(op => op.name),
  interfaces: NATIVE_OPERATIONS
    .filter(op => op.surface === 'interface-method')
    .map(op => ({ name: op.name, owner: op.owner, legacyExposure: op.legacyExposure })),
}
const nativeJson = JSON.stringify(nativeRegistry, null, 2) + NL

// ── 协议黄金样本：从 TS 实现导出（JVM 必须对每条给出相同判定）──
const versionCases = []
for (const [client, min, max] of [
  ['1.1', '1.0', '1.1'], ['1.0', '1.0', '1.1'], ['1.0', '1.2', '1.2'],
  ['1.1', '1.2', '1.2'], ['1.2', '1.0', '1.1'], ['0.9', '1.0', '1.1'],
  ['2.0', '1.0', '2.0'], ['1.1', '1.1', '1.1'],
]) {
  versionCases.push({
    clientVersion: client, serverMin: min, serverMax: max,
    expectedSupported: supportsProtocolVersion(client, min, max),
  })
}

const events = [
  { type: 'state.changed', revision: 4, transition: { revision: 4, events: [], changes: [] } },
  { type: 'model.thinking.delta', revision: 7, requestId: 'fx-1', text: '思' },
  { type: 'error', revision: 2, message: 'boom', requestId: 'fx-2' },
]
const envelopes = events.map(event => ({
  protocolVersion: CORE_PROTOCOL_VERSION,
  roomId: 'fixture-room',
  revision: event.revision,
  requestId: 'requestId' in event && typeof event.requestId === 'string' ? event.requestId : undefined,
  type: event.type,
  payload: event,
  createdAt: '2026-08-29T00:00:00.000Z',
}))
const sseFrames = envelopes.map(envelope => `data: ${JSON.stringify(envelope)}` + NL2)

const fixtures = {
  fixtureVersion: '1.0.0-gatec',
  protocolVersion: CORE_PROTOCOL_VERSION,
  minSupportedProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
  maxSupportedProtocolVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
  versionNegotiation: versionCases,
  envelopes,
  rawEvents: events,
  sseFrames,
  receipts: [
    { requestId: 'r1', status: 'accepted', revision: 8, view: { protocolVersion: '1.1', revision: 8 } },
    { requestId: 'r2', status: 'rejected', error: { code: 'command_failed', message: 'boom' } },
    { requestId: 'r3', status: 'unknown-after-disconnect', error: { code: 'connection_lost', message: 'reset' } },
  ],
  boundaries: {
    maxBodyBytes: 64 * 1024,
    sseQueueLimit: 256,
    bridgeTimeoutMs: 20000,
    binderHardLimitBytes: 64 * 1024,
    unsupportedCapabilityError: { code: 'unsupported_capability', message: 'not supported on this surface' },
  },
}
const fixturesJson = JSON.stringify(fixtures, null, 2) + NL
const fixturesSha = createHash('sha256').update(fixturesJson).digest('hex')
const fixturesWithHash = JSON.stringify({ ...fixtures, sha256: fixturesSha }, null, 2) + NL

const outDir = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets')
await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, 'native-operation-registry.json'), nativeJson)
await writeFile(path.join(outDir, 'protocol-fixtures.json'), fixturesWithHash)
console.log('written native-operation-registry.json / protocol-fixtures.json (sha256=' + fixturesSha.slice(0, 12) + ')')

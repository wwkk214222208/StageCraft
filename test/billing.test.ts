import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BillingStore } from '../src/billing.ts'

test('billing creates defaults, calculates peak/off-peak and persists aggregates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stagecraft-billing-'))
  const store = new BillingStore(join(dir, 'prices.json'), join(dir, 'stats.json'))
  assert.equal(store.getPrices().rates[0].model, '示例模型')
  store.savePrices({ version: 1, rates: [{ provider: 'p', model: 'm', currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, peak: { inputPerMillion: 3, outputPerMillion: 4 }, peakHours: [{ start: '09:00', end: '17:00' }], peakPricingEnabled: true }] })
  const peak = store.record('p', 'm', { promptTokens: 1_000_000, completionTokens: 1_000_000 }, new Date('2025-01-01T10:00:00'))
  const offPeak = store.record('p', 'm', { promptTokens: 1_000_000, completionTokens: 1_000_000 }, new Date('2025-01-01T20:00:00'))
  assert.equal(peak?.total, 7)
  assert.equal(offPeak?.total, 3)
  store.savePrices({ version: 1, rates: [{ provider: 'p', model: 'flat', currency: 'RMB', inputPerMillion: 1, outputPerMillion: 2, peak: { inputPerMillion: 9, outputPerMillion: 9 }, peakHours: [{ start: '00:00', end: '23:59' }], peakPricingEnabled: false }] })
  assert.equal(store.record('p', 'flat', { promptTokens: 1_000_000, completionTokens: 1_000_000 })?.total, 3)
  assert.equal(store.getStats().requests, 3)
  assert.equal(store.getStats().byModel.length, 2)
  store.savePrices({ version: 1, rates: [{ provider: 'p', model: 'm2', currency: 'USD', inputPerMillion: 10, outputPerMillion: 20 }] })
  store.record('p', 'm2', { promptTokens: 1_000_000, completionTokens: 1_000_000 })
  assert.deepEqual(store.getStats().byModel.map(item => item.model).sort(), ['flat', 'm', 'm2'])
  assert.equal(store.getStats().byProvider[0].model, '*')
  assert.equal(JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')).totalCost, 43)
})

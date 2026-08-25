import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TokenUsage } from './types.ts'

export interface BillingRate {
  provider: string
  model: string
  currency: string
  inputPerMillion: number
  outputPerMillion: number
  cachedInputPerMillion?: number
  peak?: { inputPerMillion?: number; outputPerMillion?: number; cachedInputPerMillion?: number }
  offPeak?: { inputPerMillion?: number; outputPerMillion?: number; cachedInputPerMillion?: number }
  peakHours?: Array<{ start: string; end: string }>
  peakPricingEnabled?: boolean
  peakExcludesWeekends?: boolean
}

export interface BillingPriceFile { version: 1; rates: BillingRate[] }
export interface BillingBucket { provider: string; model: string; requests: number; promptTokens: number; completionTokens: number; cachedTokens: number; cost: number }
export interface BillingStatsFile { version: 1; currency: string; totalCost: number; requests: number; updatedAt: string; byProvider: BillingBucket[]; byModel: BillingBucket[] }
export interface MessageCost { currency: string; total: number; input: number; output: number; cachedInput: number; peak: boolean; provider: string; model: string }

const DEFAULT_PRICES: BillingPriceFile = {
  version: 1,
  rates: [{ provider: '示例源', model: '示例模型', currency: 'RMB', inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0.25, peak: { inputPerMillion: 1.5, outputPerMillion: 3, cachedInputPerMillion: 0.4 }, offPeak: { inputPerMillion: 0.7, outputPerMillion: 1.4, cachedInputPerMillion: 0.15 }, peakHours: [{ start: '09:00', end: '21:00' }] }],
}

function number(value: unknown, fallback = 0): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback }
function normalizePrice(value: unknown): BillingPriceFile {
  const source = value && typeof value === 'object' ? value as Partial<BillingPriceFile> : {}
  const rates = Array.isArray(source.rates) ? source.rates : []
  return { version: 1, rates: rates.map(item => {
    const raw = item as BillingRate
    return { provider: String(raw.provider ?? ''), model: String(raw.model ?? ''), currency: 'RMB', inputPerMillion: number(raw.inputPerMillion), outputPerMillion: number(raw.outputPerMillion), cachedInputPerMillion: number(raw.cachedInputPerMillion), ...(raw.peak ? { peak: { inputPerMillion: number(raw.peak.inputPerMillion), outputPerMillion: number(raw.peak.outputPerMillion), cachedInputPerMillion: number(raw.peak.cachedInputPerMillion) } } : {}), ...(raw.offPeak ? { offPeak: { inputPerMillion: number(raw.offPeak.inputPerMillion), outputPerMillion: number(raw.offPeak.outputPerMillion), cachedInputPerMillion: number(raw.offPeak.cachedInputPerMillion) } } : {}), ...(Array.isArray(raw.peakHours) ? { peakHours: raw.peakHours.map(hour => ({ start: String(hour.start), end: String(hour.end) })) } : {}), peakPricingEnabled: raw.peakPricingEnabled === undefined ? (Array.isArray(raw.peakHours) && raw.peakHours.length > 0) : raw.peakPricingEnabled === true, peakExcludesWeekends: raw.peakExcludesWeekends === true }
  }).filter(rate => rate.provider && rate.model) }
}
function persist(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8'); renameSync(temp, path) }
function minute(value: string): number { const match = /^(\d{1,2}):(\d{2})$/.exec(value); return match ? Number(match[1]) * 60 + Number(match[2]) : -1 }
function isPeak(rate: BillingRate, date: Date): boolean { if (rate.peakExcludesWeekends === true) { const day = date.getDay(); if (day === 0 || day === 6) return false } const hours = rate.peakHours ?? []; const now = date.getHours() * 60 + date.getMinutes(); return hours.some(item => { const start = minute(item.start); const end = minute(item.end); if (start < 0 || end < 0 || start === end) return false; return start < end ? now >= start && now < end : now >= start || now < end }) }
function bucket(list: BillingBucket[], provider: string, model: string, byModel: boolean): BillingBucket { let item = list.find(value => byModel ? value.provider === provider && value.model === model : value.provider === provider); if (!item) { item = { provider, model: byModel ? model : '*', requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 }; list.push(item) }; return item }

export class BillingStore {
  readonly pricePath: string
  readonly statsPath: string
  private prices: BillingPriceFile
  private stats: BillingStatsFile
  constructor(pricePath: string, statsPath: string) { this.pricePath = pricePath; this.statsPath = statsPath; this.prices = this.loadPrices(); this.stats = this.loadStats() }
  private loadPrices(): BillingPriceFile { if (!existsSync(this.pricePath)) { persist(this.pricePath, DEFAULT_PRICES); return DEFAULT_PRICES }; try { return normalizePrice(JSON.parse(readFileSync(this.pricePath, 'utf8'))) } catch { return DEFAULT_PRICES } }
  private loadStats(): BillingStatsFile { if (!existsSync(this.statsPath)) return { version: 1, currency: 'RMB', totalCost: 0, requests: 0, updatedAt: new Date(0).toISOString(), byProvider: [], byModel: [] }; try { const value = JSON.parse(readFileSync(this.statsPath, 'utf8')) as BillingStatsFile; return { version: 1, currency: 'RMB', totalCost: number(value.totalCost), requests: number(value.requests), updatedAt: value.updatedAt || new Date(0).toISOString(), byProvider: Array.isArray(value.byProvider) ? value.byProvider : [], byModel: Array.isArray(value.byModel) ? value.byModel : [] } } catch { return { version: 1, currency: 'RMB', totalCost: 0, requests: 0, updatedAt: new Date(0).toISOString(), byProvider: [], byModel: [] } } }
  getPrices(): BillingPriceFile { return structuredClone(this.prices) }
  savePrices(value: unknown): BillingPriceFile { this.prices = normalizePrice(value); persist(this.pricePath, this.prices); return this.getPrices() }
  getStats(): BillingStatsFile { return structuredClone(this.stats) }
  resetStats(): void { this.stats = { version: 1, currency: 'RMB', totalCost: 0, requests: 0, updatedAt: new Date().toISOString(), byProvider: [], byModel: [] }; persist(this.statsPath, this.stats) }
  calculate(provider: string, model: string, usage: TokenUsage, at = new Date()): MessageCost | undefined {
    const rate = this.prices.rates.find(item => item.provider === provider && item.model === model) ?? this.prices.rates.find(item => item.provider === provider && item.model === '*')
    if (!rate) return undefined
    const peakEnabled = rate.peakPricingEnabled === true; const peak = peakEnabled && isPeak(rate, at); const tier = peakEnabled ? (peak ? rate.peak ?? rate : rate.offPeak ?? rate) : rate
    const input = Math.max(0, usage.promptTokens - (usage.cachedTokens ?? 0)); const cached = Math.min(usage.promptTokens, usage.cachedTokens ?? 0); const output = Math.max(0, usage.completionTokens)
    const inputCost = input * (tier.inputPerMillion ?? rate.inputPerMillion) / 1_000_000; const cachedCost = cached * (tier.cachedInputPerMillion ?? rate.cachedInputPerMillion ?? tier.inputPerMillion ?? rate.inputPerMillion) / 1_000_000; const outputCost = output * (tier.outputPerMillion ?? rate.outputPerMillion) / 1_000_000
    return { currency: rate.currency, total: inputCost + cachedCost + outputCost, input: inputCost, output: outputCost, cachedInput: cachedCost, peak, provider, model }
  }
  record(provider: string, model: string, usage: TokenUsage, at = new Date()): MessageCost | undefined { const cost = this.calculate(provider, model, usage, at); if (!cost) return undefined; this.stats.currency = cost.currency; this.stats.totalCost += cost.total; this.stats.requests += 1; this.stats.updatedAt = at.toISOString(); for (const [list, byModel] of [[this.stats.byProvider, false], [this.stats.byModel, true]] as const) { const item = bucket(list, provider, model, byModel); item.requests += 1; item.promptTokens += usage.promptTokens; item.completionTokens += usage.completionTokens; item.cachedTokens += usage.cachedTokens ?? 0; item.cost += cost.total }; persist(this.statsPath, this.stats); return cost }
}

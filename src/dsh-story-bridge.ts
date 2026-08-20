import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { CoreExtensionPort, Disposable } from './core/extensions.ts'
import type { StoryPackage } from './story-packages.ts'

export const DSH_STORY_TASKS = ['story.generate', 'story.polish', 'story.consistency', 'story.expand-opening'] as const
export type DshStoryTask = typeof DSH_STORY_TASKS[number]

const MAX_TEXT = 12_000
const MAX_ITEMS = 32
const MAX_OUTPUT = 24_000
const TASK_PREFIX = 'dsh.story.'

export interface DshStoryEnvelope {
  owner: string
  task: DshStoryTask
  title?: string
  opening?: string
  brief?: string
  text?: string
  constraints?: string[]
  source?: 'creator' | 'import'
  story?: StoryPackage
}

export interface DshStoryResult {
  task: DshStoryTask
  owner: string
  preview: string
  suggestions?: string[]
  fields?: Record<string, string>
}

interface DshTaskServices {
  agents?: { runTask?: (envelope: DshStoryEnvelope, signal: AbortSignal) => Promise<unknown> }
  llm?: unknown
  approval?: { request?: (request: { owner: string; task: string; reason: string; signal: AbortSignal }) => Promise<unknown> }
}

declare module '@deepseek-ai/cordis' {
  interface Context { dshStoryBridge?: DshTaskServices }
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function boundedText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  return value.slice(0, MAX_TEXT)
}
function assertJsonSafe(value: unknown, label: string, depth = 0): void {
  if (depth > 8 || value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`${label} must be bounded JSON.`)
  if (value === null || typeof value !== 'object') return
  if (value instanceof Date || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) throw new Error(`${label} must be bounded JSON.`)
  if (Array.isArray(value)) { if (value.length > MAX_ITEMS) throw new Error(`${label} exceeds item limit.`); for (const item of value) assertJsonSafe(item, label, depth + 1); return }
  const keys = Object.keys(value); if (keys.length > MAX_ITEMS) throw new Error(`${label} exceeds field limit.`)
  for (const key of keys) { if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`${label} contains a forbidden key.`); assertJsonSafe(value[key], label, depth + 1) }
}
function normalizeEnvelope(input: unknown, task: DshStoryTask): DshStoryEnvelope {
  if (!isRecord(input) || typeof input.owner !== 'string' || !input.owner.trim()) throw new Error('DSH story task requires an owner.')
  const envelope: DshStoryEnvelope = {
    owner: input.owner.slice(0, 128), task,
    ...(boundedText(input.title, 'title') ? { title: boundedText(input.title, 'title') } : {}),
    ...(boundedText(input.opening, 'opening') ? { opening: boundedText(input.opening, 'opening') } : {}),
    ...(boundedText(input.brief, 'brief') ? { brief: boundedText(input.brief, 'brief') } : {}),
    ...(boundedText(input.text, 'text') ? { text: boundedText(input.text, 'text') } : {}),
    ...(input.source === 'creator' || input.source === 'import' ? { source: input.source } : {}),
    ...(Array.isArray(input.constraints) ? { constraints: input.constraints.slice(0, MAX_ITEMS).map((item, index) => boundedText(item, `constraints[${index}]`) ?? '') } : {}),
    ...(input.story !== undefined ? { story: structuredClone(input.story) as StoryPackage } : {}),
  }
  assertJsonSafe(envelope, 'DSH story envelope')
  return envelope
}
function normalizeResult(value: unknown, envelope: DshStoryEnvelope): DshStoryResult {
  const source = typeof value === 'string' ? { preview: value } : isRecord(value) ? value : undefined
  if (!source || typeof source.preview !== 'string') throw new Error('DSH story task returned no preview.')
  const result: DshStoryResult = { task: envelope.task, owner: envelope.owner, preview: source.preview.slice(0, MAX_OUTPUT) }
  if (Array.isArray(source.suggestions)) result.suggestions = source.suggestions.slice(0, MAX_ITEMS).filter((item): item is string => typeof item === 'string').map(item => item.slice(0, MAX_TEXT))
  if (isRecord(source.fields)) result.fields = Object.fromEntries(Object.entries(source.fields).slice(0, MAX_ITEMS).filter(([, item]) => typeof item === 'string').map(([key, item]) => [key.slice(0, 128), (item as string).slice(0, MAX_TEXT)]))
  assertJsonSafe(result, 'DSH story result')
  return result
}
function taskId(task: DshStoryTask): string { return `${TASK_PREFIX}${task.slice('story.'.length)}` }

export interface DshStoryBridgeOptions { owner?: string }

export function dshStoryBridgeCordisPlugin(options: DshStoryBridgeOptions = {}): Plugin {
  return {
    name: 'story.dsh-bridge',
    inject: ['stagecraft'],
    apply(ctx: Context) {
      const services = { agents: ctx.get('agents', false), llm: ctx.get('llm', false), approval: ctx.get('approval', false) } as DshTaskServices
      if (!services.agents || !services.llm || !services.approval || typeof services.agents.runTask !== 'function' || typeof services.approval.request !== 'function') return
      const ownerPrefix = (options.owner ?? 'story.dsh-bridge').slice(0, 128)
      const registrations: Disposable[] = []
      ctx.effect(() => {
        for (const task of DSH_STORY_TASKS) {
          const id = taskId(task)
          registrations.push(ctx.stagecraft.extensions.registerEffectHandler({ id, async handle(input) {
            const envelope = normalizeEnvelope(input, task)
            if (!envelope.owner.startsWith(`${ownerPrefix}:`)) throw new Error('DSH story task owner is outside this bridge scope.')
            const controller = new AbortController()
            const approval = await services.approval!.request!({ owner: envelope.owner, task, reason: `Approve ${task} preview`, signal: controller.signal })
            if (approval !== 'allowed-once' && approval !== true && !(isRecord(approval) && approval.allowed === true)) throw new Error('DSH story task was not approved.')
            const output = await services.agents!.runTask!(structuredClone(envelope), controller.signal)
            return normalizeResult(output, envelope)
          } }))
        }
        return () => { for (const registration of registrations.splice(0)) registration.dispose() }
      })
    },
  }
}

export function dshStoryTaskIds(): string[] { return DSH_STORY_TASKS.map(taskId) }
export function dshStoryTaskHandler(core: CoreExtensionPort, task: DshStoryTask): (input: unknown) => Promise<unknown> { return input => core.invokeEffect(taskId(task), input) }

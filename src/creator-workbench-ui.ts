import type { CreatorExtractionPreview } from './creator-contracts.ts'
import type { DshStoryTask } from './dsh-story-bridge.ts'
import { DSH_STORY_TASKS } from './dsh-story-bridge.ts'
import type { UiActionDefinition, UiActionHandler, UiBinding, UiManifest, UiNode } from './core/ui.ts'

/** State namespace projected by the Creator Workbench host. Values are summaries/candidates supplied by the host. */
export const CREATOR_WORKBENCH_MODULE = 'creator.workbench'
export const CREATOR_WORKBENCH_MANIFEST = 'creator.workbench.ui'

export interface CreatorWorkbenchCapabilities {
  extract?: boolean
  tasks?: Partial<Record<DshStoryTask, boolean>>
}

export interface CreatorWorkbenchController {
  importText(input: { text: string; title?: string }): unknown | Promise<unknown>
  importStCard(input: { parsed: unknown; name?: string }): unknown | Promise<unknown>
  extract(input: { previewId?: string }): unknown | Promise<unknown>
  runTask(task: DshStoryTask, input: Record<string, unknown>): unknown | Promise<unknown>
  decideField(input: { path: string; decision: 'accept' | 'reject' }): unknown | Promise<unknown>
  apply(input?: { previewId?: string }): unknown | Promise<unknown>
  revert(input?: { previewId?: string }): unknown | Promise<unknown>
}

export interface CreatorWorkbenchUiOptions {
  owner: string
  capabilities?: CreatorWorkbenchCapabilities
  controller: CreatorWorkbenchController
  version?: string
}

const binding = (path: string, fallback?: unknown): UiBinding => ({ path, ...(fallback === undefined ? {} : { fallback: fallback as never }) })
const path = (suffix: string) => `/modules/${CREATOR_WORKBENCH_MODULE}/${suffix}`

function action(owner: string, suffix: string, label: string, capability?: string, confirmation?: string): UiActionDefinition {
  return { id: `${owner}.creator.${suffix}`, label, ...(capability ? { capability: { id: capability, optional: true } } : {}), ...(confirmation ? { confirmation } : {}) }
}

function workbenchNodes(owner: string, actions: Record<string, UiActionDefinition>): { tree: UiNode[]; editor: UiNode[]; preview: UiNode[] } {
  return {
    tree: [
      { type: 'text', id: 'story-tree-heading', text: 'Story tree' },
      { type: 'list', id: 'story-tree', items: binding(path('storyTree'), []), item: { type: 'text', text: binding('/item/label', '') }, emptyText: 'No story fields yet.' },
      { type: 'stack', id: 'import-actions', direction: 'row', children: [
        { type: 'button', id: 'import-text', label: actions.importText.label, action: actions.importText.id },
        { type: 'button', id: 'import-card', label: actions.importStCard.label, action: actions.importStCard.id },
      ] },
    ],
    editor: [
      { type: 'text', id: 'editor-heading', text: 'StoryPackage editor' },
      { type: 'text-input', id: 'title', label: 'Title', value: binding(path('editor/title'), ''), action: `${owner}.creator.field.edit`, placeholder: 'Story title' },
      { type: 'text-input', id: 'opening', label: 'Opening', value: binding(path('editor/opening'), ''), action: `${owner}.creator.field.edit`, multiline: true },
      { type: 'markdown', id: 'editor-preview', source: binding(path('editor/markdown'), '') },
      { type: 'stack', id: 'editor-actions', direction: 'row', children: [
        { type: 'button', id: 'apply', label: actions.apply.label, action: actions.apply.id, disabled: binding(path('actions/applyDisabled'), false) },
        { type: 'button', id: 'revert', label: actions.revert.label, action: actions.revert.id },
      ] },
    ],
    preview: [
      { type: 'text', id: 'preview-heading', text: 'Agent preview / apply' },
      { type: 'markdown', id: 'preview', source: binding(path('preview/summary'), 'No preview available.') },
      { type: 'table', id: 'field-diffs', rows: binding(path('preview/diffs'), []), columns: [
        { id: 'field', label: 'Field', value: binding('/item/path', '') },
        { id: 'change', label: 'Change', value: binding('/item/change', '') },
        { id: 'decision', label: 'Decision', value: binding('/item/decision', 'unchanged') },
      ] },
      { type: 'stack', id: 'field-actions', direction: 'row', children: [
        { type: 'button', id: 'accept-field', label: actions.acceptField.label, action: actions.acceptField.id },
        { type: 'button', id: 'reject-field', label: actions.rejectField.label, action: actions.rejectField.id },
      ] },
      { type: 'collapse', id: 'warnings', title: 'Warnings', open: true, content: [{ type: 'list', items: binding(path('warnings'), []), item: { type: 'text', text: binding('/item/message', '') }, emptyText: 'No warnings.' }] },
      { type: 'stack', id: 'agent-actions', direction: 'row', children: [
        ...(actions.extract ? [{ type: 'button', id: 'extract', label: actions.extract.label, action: actions.extract.id }] : []),
        ...(actions.generate ? [{ type: 'button', id: 'generate', label: actions.generate.label, action: actions.generate.id }] : []),
        ...(actions.expand ? [{ type: 'button', id: 'expand', label: actions.expand.label, action: actions.expand.id }] : []),
        ...(actions.polish ? [{ type: 'button', id: 'polish', label: actions.polish.label, action: actions.polish.id }] : []),
        ...(actions.consistency ? [{ type: 'button', id: 'consistency', label: actions.consistency.label, action: actions.consistency.id }] : []),
      ] },
    ],
  }
}

/** Builds the one manifest consumed by Android and Web. No DOM or platform types cross this boundary. */
export function createCreatorWorkbenchUi(options: CreatorWorkbenchUiOptions): { manifest: UiManifest; handlers: UiActionHandler[] } {
  if (!options.owner.trim()) throw new Error('Creator Workbench owner is required.')
  const capabilities = options.capabilities ?? {}
  const definitions: Record<string, UiActionDefinition> = {
    importText: action(options.owner, 'import-text', 'Import text'),
    importStCard: action(options.owner, 'import-st-card', 'Import ST card'),
    fieldEdit: action(options.owner, 'field-edit', 'Edit field'),
    acceptField: action(options.owner, 'field-accept', 'Accept field'),
    rejectField: action(options.owner, 'field-reject', 'Reject field'),
    apply: action(options.owner, 'apply', 'Apply accepted fields', undefined, 'Apply accepted StoryPackage fields?'),
    revert: action(options.owner, 'revert', 'Revert changes', undefined, 'Revert Creator Workbench changes?'),
  }
  if (capabilities.extract !== false) definitions.extract = action(options.owner, 'extract', 'Extract story', 'story.extract')
  const taskNames: Record<DshStoryTask, keyof typeof definitions> = { 'story.generate': 'generate', 'story.expand-opening': 'expand', 'story.polish': 'polish', 'story.consistency': 'consistency' }
  for (const task of DSH_STORY_TASKS) if (capabilities.tasks?.[task] !== false) definitions[taskNames[task]] = action(options.owner, taskNames[task], task === 'story.expand-opening' ? 'Expand opening' : task.slice('story.'.length), `dsh.${task}`)

  const nodes = workbenchNodes(options.owner, definitions)
  const manifest: UiManifest = { id: CREATOR_WORKBENCH_MANIFEST, version: options.version ?? '1.0.0', owner: options.owner, title: 'Creator Workbench', panels: [
    { id: 'story-tree', title: 'Story tree', content: nodes.tree },
    { id: 'story-editor', title: 'StoryPackage editor', content: nodes.editor },
    { id: 'agent-preview', title: 'Agent preview / apply', content: nodes.preview },
  ], actions: Object.values(definitions), capabilities: [{ id: 'story.extract', optional: true }, ...DSH_STORY_TASKS.map(task => ({ id: `dsh.${task}`, optional: true }))] }
  const handler = (definition: UiActionDefinition, execute: (input: any) => unknown | Promise<unknown>): UiActionHandler => ({ definition, execute })
  const handlers: UiActionHandler[] = [
    handler(definitions.importText, input => options.controller.importText(input)), handler(definitions.importStCard, input => options.controller.importStCard(input)), handler(definitions.fieldEdit, input => options.controller.decideField({ path: input.path, decision: input.value })), handler(definitions.acceptField, input => options.controller.decideField({ path: input.path, decision: 'accept' })), handler(definitions.rejectField, input => options.controller.decideField({ path: input.path, decision: 'reject' })), handler(definitions.apply, input => options.controller.apply(input)), handler(definitions.revert, input => options.controller.revert(input)),
  ]
  if (definitions.extract) handlers.push(handler(definitions.extract, input => options.controller.extract(input)))
  for (const task of DSH_STORY_TASKS) { const key = taskNames[task]; if (definitions[key]) handlers.push(handler(definitions[key], input => options.controller.runTask(task, input))) }
  return { manifest, handlers }
}

export type CreatorWorkbenchPreview = CreatorExtractionPreview

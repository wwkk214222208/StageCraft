import assert from 'node:assert/strict'
import test from 'node:test'
import { createCreatorWorkbenchUi } from '../src/creator-workbench-ui.ts'
import { validateUiManifest, type UiActionDefinition } from '../src/core/ui.ts'
import { ReferenceUiRendererHost } from '../src/core/renderer-host.ts'
import type { CoreView } from '../src/core/protocol.ts'

function controller() {
  const calls: unknown[] = []
  return { calls,
    importText: (input: unknown) => calls.push(['text', input]), importStCard: (input: unknown) => calls.push(['card', input]), extract: (input: unknown) => calls.push(['extract', input]),
    decideField: (input: unknown) => calls.push(['field', input]), apply: (input: unknown) => calls.push(['apply', input]), revert: (input: unknown) => calls.push(['revert', input]),
  }
}
function view(): CoreView { return { revision: 1, state: { modules: { 'creator.workbench': { storyTree: [], editor: {}, preview: { diffs: [], summary: '' }, warnings: [] } } }, ui: { revision: 1, panels: [], theme: [] } } as CoreView }

test('Creator Workbench is a three-column shared manifest without task-specific Agent actions', () => {
  const c = controller(); const result = createCreatorWorkbenchUi({ owner: 'creator:test', controller: c })
  validateUiManifest(result.manifest)
  assert.deepEqual(result.manifest.panels.map(panel => panel.title), ['剧本结构', '剧本包编辑器', 'DSH 会话'])
  const ids = result.manifest.actions!.map(action => action.id)
  assert.ok(ids.includes('creator:test.creator.import-text'))
  assert.ok(ids.includes('creator:test.creator.import-st-card'))
  assert.ok(!ids.some(id => /extract|generate|expand|polish|consistency/.test(id)))
  assert.ok(ids.includes('creator:test.creator.field-accept'))
  assert.ok(ids.includes('creator:test.creator.field-reject'))
  assert.ok(ids.includes('creator:test.creator.apply'))
  assert.ok(ids.includes('creator:test.creator.revert'))
  assert.ok(result.manifest.panels[2].content.some(node => node.type === 'collapse' && node.title === '警告'))
})

test('same manifest renders through the DOM-free reference host and handlers preserve owner isolation', async () => {
  const c = controller(); const result = createCreatorWorkbenchUi({ owner: 'creator:web', controller: c, capabilities: { extract: false } })
  const currentView = () => ({ ...view(), ui: { revision: 1, panels: result.manifest.panels.map(panel => ({ manifestId: result.manifest.id, owner: result.manifest.owner, panel, visible: true })), theme: [] } }) as CoreView
  const core = { getView: currentView, invokeUiAction: async (id: string, input: unknown, owner: string) => { if (owner !== result.manifest.owner) throw new Error('owner mismatch'); const handler = result.handlers.find(item => item.definition.id === id)!; return handler.execute(input, { owner, view: currentView() }) } }
  const rendered = new ReferenceUiRendererHost(core).render(currentView())
  assert.deepEqual(rendered.panels.map(panel => panel.title), ['剧本结构', '剧本包编辑器', 'DSH 会话'])
  const accept = result.manifest.actions!.find(item => item.id.endsWith('field-accept')) as UiActionDefinition
  await core.invokeUiAction(accept.id, { path: '/title' }, 'creator:web')
  assert.deepEqual(c.calls, [['field', { path: '/title', decision: 'accept' }]])
  await assert.rejects(() => core.invokeUiAction(accept.id, { path: '/title' }, 'other-owner'), /owner mismatch/)
})

import { resolveUiBinding, type UiBinding, type UiNode, type UiRenderResult, type UiRendererHost, type UiValue } from './ui.ts'
import type { CoreView } from './protocol.ts'

export interface UiReferenceNode {
  type: UiNode['type']
  id?: string
  properties: Record<string, UiValue>
  children?: UiReferenceNode[]
}

export interface UiReferencePanel {
  manifestId: string
  owner: string
  id: string
  title: string
  nodes: UiReferenceNode[]
}

export interface UiReferenceTree {
  revision: number
  panels: UiReferencePanel[]
  theme: UiRenderResult['theme']
}

export interface UiReferenceCore {
  getView(): CoreView
  invokeUiAction(actionId: string, input: unknown, owner: string): Promise<unknown>
}

/**
 * DOM-free common renderer contract. Platform renderers consume this tree and
 * decide only platform presentation, never Core access or binding semantics.
 */
export class ReferenceUiRendererHost implements UiRendererHost<UiReferenceTree> {
  private readonly core: UiReferenceCore

  constructor(core: UiReferenceCore) {
    this.core = core
  }

  render(view = this.core.getView()): UiReferenceTree {
    const projection = view.ui ?? { revision: view.revision, panels: [], theme: [] }
    return {
      revision: projection.revision,
      theme: structuredClone(projection.theme),
      panels: projection.panels.filter(panel => panel.visible).map(panel => ({
        manifestId: panel.manifestId,
        owner: panel.owner,
        id: panel.panel.id,
        title: panel.panel.title,
        nodes: panel.panel.content.map(node => this.node(node, view.state)),
      })),
    }
  }

  invoke(actionId: string, input: unknown, owner?: string): Promise<unknown> {
    if (!owner) throw new Error('UI action owner is required.')
    return this.core.invokeUiAction(actionId, structuredClone(input), owner)
  }

  private node(node: UiNode, state: unknown): UiReferenceNode {
    const properties: Record<string, UiValue> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'id' || key === 'content' || key === 'children' || key === 'tabs' || key === 'item') continue
      properties[key] = this.value(value, state)
    }
    const children = 'content' in node ? node.content.map(child => this.node(child, state))
      : 'children' in node ? node.children.map(child => this.node(child, state))
        : 'tabs' in node ? node.tabs.flatMap(tab => tab.content.map(child => this.node(child, state)))
          : 'item' in node ? [this.node(node.item, state)] : undefined
    return { type: node.type, ...(node.id ? { id: node.id } : {}), properties, ...(children ? { children } : {}) }
  }

  private value(value: unknown, state: unknown): UiValue {
    if (this.isBinding(value)) return this.asUiValue(resolveUiBinding(value, state))
    return this.asUiValue(value)
  }

  private isBinding(value: unknown): value is UiBinding {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as UiBinding).path === 'string' && Object.keys(value as object).every(key => key === 'path' || key === 'fallback'))
  }

  private asUiValue(value: unknown): UiValue {
    if (value === undefined) return null
    return structuredClone(value) as UiValue
  }
}

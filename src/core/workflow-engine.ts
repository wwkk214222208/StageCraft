import type { CoreAction, StateEvent, WorkflowDefinition, WorkflowInstance } from './protocol.ts'

/** 校验固定、版本化 Workflow 的结构，供直接注册与方案事务注册共用。 */
export function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  if (!definition.id || !definition.version || !definition.initialStep) throw new Error('Invalid workflow definition.')
  if (!definition.steps || !definition.steps[definition.initialStep]) throw new Error(`Workflow initial step is missing: ${definition.initialStep}`)
  for (const [key, step] of Object.entries(definition.steps)) {
    if (key !== step.id) throw new Error(`Workflow step id does not match key: ${key}`)
  }
  for (const transition of definition.transitions) {
    if (!definition.steps[transition.from]) throw new Error(`Workflow transition source step is missing: ${transition.from}`)
    if (!definition.steps[transition.to]) throw new Error(`Workflow transition target step is missing: ${transition.to}`)
  }
}

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>()

  register(definition: WorkflowDefinition): void {
    validateWorkflowDefinition(definition)
    if (this.definitions.has(definition.id)) throw new Error(`Workflow already registered: ${definition.id}`)
    this.definitions.set(definition.id, definition)
  }

  get(id: string): WorkflowDefinition {
    const definition = this.definitions.get(id)
    if (!definition) throw new Error(`Workflow is not registered: ${id}`)
    return definition
  }

  list(): WorkflowDefinition[] {
    return [...this.definitions.values()]
  }

  unregister(id: string): void {
    this.definitions.delete(id)
  }
}

/** 固定 Workflow 的纯 action 规划器；不执行 HTTP、模型或 Store 副作用。 */
export class WorkflowExecutor {
  private readonly registry: WorkflowRegistry

  constructor(registry: WorkflowRegistry) {
    this.registry = registry
  }

  plan(instance: WorkflowInstance): CoreAction[] {
    const definition = this.registry.get(instance.definitionId)
    const step = definition.steps[instance.step]
    if (!step) throw new Error(`Workflow step is not defined: ${instance.definitionId}/${instance.step}`)
    return step.actions.map(action => {
      if (action.type === 'human-interaction') {
        return { type: 'human-interaction', request: { id: `workflow-interaction:${instance.id}`, kind: action.interactionKind, title: action.label, createdAt: new Date().toISOString() }, workflowId: instance.id } satisfies CoreAction
      }
      if (action.type === 'model-interaction') {
        return { type: 'model-interaction', request: { requestId: `workflow-request:${instance.id}`, workflowId: instance.id, capability: action.capability, prompt: { system: '', user: '', metadata: { capability: action.capability, strategyId: action.promptProfile } }, contract: { id: action.contractId, version: '1.0.0', schema: {} }, stream: action.stream }, workflowId: instance.id } satisfies CoreAction
      }
      if (action.type === 'local-compute') return { type: 'local-compute', operation: action.operation, input: {}, workflowId: instance.id } satisfies CoreAction
      if (action.type === 'state-commit') return { type: 'state-commit', events: [], workflowId: instance.id } satisfies CoreAction
      return { type: 'emit', eventType: action.type === 'emit' ? action.eventType : 'workflow.finish', payload: {}, workflowId: instance.id } satisfies CoreAction
    })
  }

  transition(instance: WorkflowInstance, event: StateEvent): WorkflowInstance {
    const definition = this.registry.get(instance.definitionId)
    const transition = definition.transitions.find(item => item.from === instance.step && item.event === event.type)
    if (!transition) return instance
    return { ...instance, step: transition.to, status: transition.to.startsWith('awaiting-') ? 'waiting' : 'running', updatedAt: new Date().toISOString() }
  }
}

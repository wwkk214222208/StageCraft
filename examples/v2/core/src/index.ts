import { defineCore } from '../../../../src/sdk/index.ts'
export default defineCore({ id: 'example.stagecraft.core', version: '1.0.0', title: 'Example replaceable Core', start(context) {
  const values = (context.components ?? []).map(component => component.defaultExport as any)
  const solution = values.find(value => value?.kind === 'solution')
  const tool = values.find(value => value?.kind === 'tool')
  const llm = context.llmSystems?.[0]?.service
  if (!solution || !llm || !tool) throw new Error('demo components missing')
  context.registerCommand('demo/run', async (input: any) => {
    const assembled = await solution.assemblePrompt({ user: String(input?.user ?? '') }, context as any)
    const messages = [{ role: 'system', content: solution.systemPrompt }, { role: 'user', content: assembled }]
    const chunks = []; for await (const chunk of llm.complete({ requestId: 'demo-request', messages })) chunks.push(chunk)
    return { messages, chunks, tool: await tool.execute(input?.tool ?? 'ok', context as any) }
  })
  context.registerCommand('demo/ping', () => ({ ok: true, core: context.pluginId })); context.ready()
} })

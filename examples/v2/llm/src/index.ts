import { createDefaultLlmSystemService, defineLlmSystem } from '../../../../src/sdk/index.ts'

export default defineLlmSystem({
  id: 'example.stagecraft.llm',
  version: '1.0.0',
  title: 'Example LLM System',
  async start(context) {
    const service = await createDefaultLlmSystemService(context)
    await service.upsertCredentialProfile({ id: 'demo-profile', providerId: 'demo', label: 'Demo (no secret)' })
    return service
  },
})

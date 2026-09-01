import { defineSolution } from '../../../../src/sdk/index.ts'
export default defineSolution({ id: 'example.stagecraft.solution', version: '1.0.0', title: 'Example Solution', systemPrompt: 'You are the StageCraft demo narrator.', assemblePrompt({ user }) { return `User says: ${user}` } })

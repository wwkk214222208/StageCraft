import { defineToolPlugin } from '../../../../src/sdk/index.ts'
export default defineToolPlugin({ id: 'example.stagecraft.tool', version: '1.0.0', title: 'Example Tool', execute(input) { return { tool: 'echo', input } } })

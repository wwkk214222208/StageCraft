import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

test('Creator Workbench exposes native DSH story assistant wiring', () => {
  assert.match(html, /DSH 剧情编辑助手/)
  assert.match(html, /id="creator-player-input"/)
  assert.match(html, /id="creator-session-open"/)
  assert.doesNotMatch(html, /id="creator-apply"/)
  assert.doesNotMatch(html, /id="creator-extract"/)
  assert.match(app, /creatorRequest\('\/api\/agent\/message'/)
  assert.match(app, /waitForCreatorAgentFileChange/)
  assert.match(app, /creator-player-input/)
})

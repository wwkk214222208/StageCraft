import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
const root = new URL('..', import.meta.url)
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

test('Creator Workbench exposes explicit apply and revert browser wiring', () => {
  assert.match(html, /id="creator-apply"[^>]*disabled/)
  assert.match(html, /id="creator-revert"[^>]*disabled/)
  assert.match(app, /creatorRequest\('\/api\/creator\/apply'/)
  assert.match(app, /creatorRequest\('\/api\/creator\/revert'/)
  assert.match(app, /previewId: preview\.id/)
  assert.match(app, /decision === 'accept' \|\| diff\.decision === 'reject'/)
  assert.match(app, /window\.creatorPreview = null/)
  assert.match(app, /普通保存仍使用 \/api\/story\/save/)
})

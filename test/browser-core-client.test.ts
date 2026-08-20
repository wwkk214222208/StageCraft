import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreClient } from '../public/core-client.js'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('browser CoreClient parses split CRLF/multi-data SSE and close aborts the stream', async () => {
  const encoder = new TextEncoder()
  const received: Array<Record<string, unknown>> = []
  let streamAborted = false
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer browser-session')
    if (input.endsWith('/events')) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () => { streamAborted = true; try { controller.close() } catch {} }, { once: true })
          for (const part of [
            'da', 'ta: {\r', '\ndata: "type": "state.changed",\r', '\nda', 'ta: "revision": 4,\r',
            '\ndata: "source": "browser-test"\r', '\ndata: }\r', '\n\r', '\n',
          ]) controller.enqueue(encoder.encode(part))
          controller.enqueue(encoder.encode('data: {"type":"workflow.changed","revision":4,"source":"carriage-return"}\r\r'))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (input.endsWith('/view')) {
      return Response.json({ protocolVersion: '1.0', revision: 3, state: {}, workflows: [], interactions: [], actions: [], availableCommands: [], recentEvents: [] })
    }
    return new Response(null, { status: 404 })
  }
  const client = new CoreClient({ viewPath: 'http://browser.test/view', eventsPath: 'http://browser.test/events', session: 'browser-session', fetchImpl })
  const release = client.subscribe((message: Record<string, unknown>) => received.push(message))
  await waitFor(() => received.some(message => message.type === 'state.changed'))
  assert.equal(received[0].type, 'core.resync')
  assert.equal(received[0].revision, 3)
  const coreEvent = received.find(message => message.type === 'state.changed')
  assert.deepEqual(coreEvent, { type: 'state.changed', revision: 4, source: 'browser-test' })
  assert.ok(received.some(message => message.type === 'workflow.changed' && message.source === 'carriage-return'))
  client.close(); client.close(); release(); release()
  await waitFor(() => streamAborted)
})

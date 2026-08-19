import assert from 'node:assert/strict'
import test from 'node:test'
import { Service } from '@deepseek-ai/cordis'
import { createCordisContext, createCordisRuntime } from '../src/cordis-runtime.ts'

test('Cordis Context installs a plugin and exposes its provided service', async () => {
  const runtime = createCordisRuntime()
  let applied = 0
  const fiber = runtime.install({
    name: 'test.service-provider',
    apply(ctx) {
      applied += 1
      ctx.provide('testService', { value: 42 })
    },
  })

  await fiber
  assert.equal(applied, 1)
  assert.deepEqual((runtime.ctx as unknown as { testService: { value: number } }).testService, { value: 42 })
  await runtime.dispose()
})

test('Cordis waits for an injected service before activating a plugin', async () => {
  const ctx = createCordisContext()
  let applied = 0
  const fiber = ctx.plugin({
    name: 'test.waiting-plugin',
    inject: ['testDependency'],
    apply(receiving) {
      applied += 1
      assert.deepEqual((receiving as unknown as { testDependency: unknown }).testDependency, { ready: true })
    },
  })

  assert.equal(applied, 0)
  const disposeDependency = ctx.provide('testDependency', { ready: true })
  await fiber
  assert.equal(applied, 1)
  await fiber.dispose()
  await disposeDependency()
})

test('disposing a Cordis Fiber releases effects and runtime shutdown is idempotent', async () => {
  const runtime = createCordisRuntime()
  const lifecycle: string[] = []
  const fiber = runtime.install({
    name: 'test.lifecycle',
    apply(ctx) {
      ctx.effect(() => {
        lifecycle.push('setup')
        return () => { lifecycle.push('cleanup') }
      })
    },
  })

  await fiber
  assert.deepEqual(lifecycle, ['setup'])
  await fiber.dispose()
  assert.deepEqual(lifecycle, ['setup', 'cleanup'])
  await runtime.dispose()
  assert.deepEqual(lifecycle, ['setup', 'cleanup'])
})

test('Cordis rejects duplicate service registration', async () => {
  const runtime = createCordisRuntime()
  const provider = runtime.install({
    name: 'test.first-provider',
    apply(ctx) { ctx.provide('duplicateService', { owner: 'first' }) },
  })
  await provider

  const duplicate = runtime.install({
    name: 'test.duplicate-provider',
    apply(ctx) { ctx.provide('duplicateService', { owner: 'second' }) },
  })
  // Cordis Fibers are thenables rather than native Promise instances.
  await assert.rejects(Promise.resolve(duplicate), /service "duplicateService" has been registered/)
  await runtime.dispose()
})

test('a Service subclass registers with its Fiber and is removed on unload', async () => {
  const runtime = createCordisRuntime()
  class TestService extends Service {
    static override provide = 'testClassService'
    readonly value = 'service-value'
  }
  const fiber = runtime.install({
    name: 'test.class-service-provider',
    apply(ctx) {
      new TestService(ctx)
    },
  })

  await fiber
  assert.equal((runtime.ctx as unknown as { testClassService: TestService }).testClassService.value, 'service-value')
  await fiber.dispose()
  assert.equal(runtime.ctx.get('testClassService', false), undefined)
  await runtime.dispose()
})

test('ctx.inject callback activates after delayed service and cleans up when it disappears', async () => {
  const ctx = createCordisContext()
  const lifecycle: string[] = []
  const fiber = ctx.inject(['delayedService'], receiving => {
    assert.deepEqual((receiving as unknown as { delayedService: unknown }).delayedService, { ready: true })
    receiving.effect(() => {
      lifecycle.push('activated')
      return () => { lifecycle.push('released') }
    })
  })

  assert.deepEqual(lifecycle, [])
  const disposeDependency = ctx.provide('delayedService', { ready: true })
  await fiber
  assert.deepEqual(lifecycle, ['activated'])
  await disposeDependency()
  await fiber.await()
  assert.deepEqual(lifecycle, ['activated', 'released'])
  await fiber.dispose()
})

test('Cordis runtime rejects installation after dispose', async () => {
  const runtime = createCordisRuntime()
  await runtime.dispose()
  assert.throws(() => runtime.install({ name: 'test.after-dispose', apply() {} }), /runtime is disposed/)
})

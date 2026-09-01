/**
 * M4 desktop v2 Host reference path. This is deliberately separate from the
 * v1 app-boot composition root; selecting a v2 plan never constructs it.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isLoopbackHost } from '../remote-access.ts'
import type { ComponentLaunchPlan, ComponentManifest } from './component-contract.ts'
import { validateComponentLaunchPlan } from './launch-plan.ts'
import { validateComponentManifest, isPortableRelativePath } from './component-validation.ts'
import { negotiateCapabilities } from './capabilities.ts'
import { capabilityForHostOperation, createNodeFileComponentStorage, type ComponentStoragePort, type HostPortCaller } from './component-storage.ts'
import { HOST_CORE_ABI_VERSION, type HostCoreEntry, type LoadedCoreComponent, HostCoreSession } from './host-core-abi.ts'

export interface V2DesktopHostOptions {
  userDataRoot: string
  planPath?: string
  componentsRoot?: string
  host?: string
  port?: number
  availableCapabilities?: readonly string[]
  maxBodyBytes?: number
  /** Defaults to the Node file store under `<userDataRoot>/data/v2-storage`. */
  storage?: ComponentStoragePort
}

export interface V2DesktopHost {
  readonly server: Server
  readonly session: HostCoreSession
  readonly plan: ComponentLaunchPlan
  readonly coreManifest: ComponentManifest
  readonly diagnostics: readonly string[]
  close(): Promise<void>
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024
let importNonce = 0

export async function startV2DesktopHost(options: V2DesktopHostOptions): Promise<V2DesktopHost> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8787
  if (!isLoopbackHost(host)) throw stageError('listen', undefined, `v2 Host only permits loopback host (received ${host})`)
  const planPath = resolve(options.planPath ?? join(options.userDataRoot, 'data', 'component-launch-plan.v2.json'))
  const componentsRoot = resolve(options.componentsRoot ?? join(options.userDataRoot, 'components'))
  const plan = readJson(planPath, 'plan') as ComponentLaunchPlan
  if (!plan || typeof plan !== 'object' || !plan.core || typeof plan.core !== 'object' || !Array.isArray(plan.plugins)) throw stageError('plan', undefined, 'plan must contain a core selection and plugins array')
  const selectedManifests = [readSelectedManifest(componentsRoot, plan.core.id, plan.core.version), ...(plan.plugins ?? []).map(selection => readSelectedManifest(componentsRoot, selection.id, selection.version))]
  const planErrors = validateComponentLaunchPlan(plan, selectedManifests)
  if (planErrors.length) throw stageError('plan', plan.core?.id, planErrors.join('; '))
  const coreManifest = selectedManifests[0]
  for (const selectedManifest of selectedManifests) {
    const manifestErrors = validateComponentManifest(selectedManifest)
    if (manifestErrors.length) throw stageError('manifest', selectedManifest.id, manifestErrors.join('; '))
  }
  if (coreManifest.hostApi?.version !== HOST_CORE_ABI_VERSION) throw stageError('manifest', coreManifest.id, `Host API ${coreManifest.hostApi?.version ?? 'missing'} is not supported (expected ${HOST_CORE_ABI_VERSION})`)
  const diagnostics: string[] = []
  const grantedCapabilities = new Map<string, ReadonlySet<string>>()
  const availableCapabilities = options.availableCapabilities ?? ['host.log', 'host.storage']
  for (const selectedManifest of selectedManifests) {
    const capabilityResult = negotiateCapabilities(selectedManifest.capabilities, availableCapabilities)
    if (!capabilityResult.ok) throw stageError('capability', selectedManifest.id, `required capabilities unavailable: ${capabilityResult.missingRequired.join(', ')}`)
    grantedCapabilities.set(selectedManifest.id, new Set(capabilityResult.granted))
    diagnostics.push(...capabilityResult.deniedOptional.map(capability => `optional capability denied: ${capability}`))
  }
  const verified = selectedManifests.map(component => ({
    manifest: component,
    runtimePath: verifyArtifact(componentsRoot, component, component.entrypoints.runtime, component.integrity.runtime, 'runtime entry'),
    uiPath: component.entrypoints.ui
      ? verifyArtifact(componentsRoot, component, component.entrypoints.ui, component.integrity.ui, 'ui entry')
      : undefined,
  }))
  const uiEntries = verified.filter(component => component.uiPath).map(component => ({ id: component.manifest.id, version: component.manifest.version, path: component.uiPath! }))
  const loadedComponents: LoadedCoreComponent[] = []
  // All selected artifacts are checked before any third-party module is imported.
  for (const component of verified.slice(1)) {
    try {
      const loaded = await import(`${pathToFileURL(component.runtimePath).href}?stagecraftM4=${++importNonce}`)
      loadedComponents.push(Object.freeze({ manifest: immutableJson(component.manifest), defaultExport: loaded.default, module: Object.freeze({ ...loaded }) }))
    } catch (error) {
      throw stageError('import', component.manifest.id, error instanceof Error ? error.message : String(error))
    }
  }
  let entry: HostCoreEntry
  try {
    const moduleUrl = `${pathToFileURL(verified[0].runtimePath).href}?stagecraftM4=${++importNonce}`
    const loaded = await import(moduleUrl)
    entry = adaptCoreExport(loaded.default, coreManifest)
  } catch (error) {
    throw stageError('import', coreManifest.id, error instanceof Error ? error.message : String(error))
  }
  const session = new HostCoreSession(plan, createHostPort({
    diagnostics,
    grants: grantedCapabilities,
    storage: options.storage ?? createNodeFileComponentStorage(join(options.userDataRoot, 'data', 'v2-storage')),
  }), loadedComponents)
  try {
    await session.boot(entry)
  } catch (error) {
    let cleanupError: unknown
    try { await cleanupEntry(entry, session) } catch (failure) { cleanupError = failure }
    const message = error instanceof Error ? error.message : String(error)
    throw stageError('handshake', coreManifest.id, cleanupError ? `${message}; cleanup failed: ${errorMessage(cleanupError)}` : message)
  }
  let server: Server | undefined
  try {
    server = createHttpServer(session, plan, coreManifest, diagnostics, uiEntries, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
    await listen(server, port, host)
  } catch (error) {
    let cleanupError: unknown
    try { await cleanupEntry(entry, session) } catch (failure) { cleanupError = failure }
    const message = error instanceof Error ? error.message : String(error)
    throw stageError('listen', coreManifest.id, cleanupError ? `${message}; cleanup failed: ${errorMessage(cleanupError)}` : message)
  }
  let closed = false
  return {
    server, session, plan, coreManifest, diagnostics,
    async close() {
      if (closed) return
      closed = true
      await stopServer(server!)
      try { await cleanupEntry(entry, session) } catch (error) { throw stageError('close', coreManifest.id, errorMessage(error)) }
    },
  }
}

function readJson(path: string, label: string): unknown {
  if (!existsSync(path) || statSync(path).isDirectory()) throw stageError('plan', undefined, `${label} file is missing: ${path}`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { throw stageError('plan', undefined, `invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`) }
}

function readSelectedManifest(componentsRoot: string, id: string, version: string): ComponentManifest {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(id) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw stageError('manifest', id, 'selected component identity is invalid')
  let componentDir: string
  try { componentDir = safeRootPath(componentsRoot, join(id, version), 'component directory', id) } catch (error) { throw error }
  const manifestPath = safeRootPath(componentDir, 'manifest.json', 'manifest', id)
  if (!existsSync(manifestPath) || statSync(manifestPath).isDirectory()) throw stageError('manifest', id, `component manifest is missing: ${manifestPath}`)
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')) as ComponentManifest } catch (error) { throw stageError('manifest', id, `invalid component manifest JSON: ${error instanceof Error ? error.message : String(error)}`) }
}

function verifyArtifact(componentsRoot: string, manifest: ComponentManifest, entry: string, expected: string | undefined, label: string): string {
  const componentDir = safeRootPath(componentsRoot, join(manifest.id, manifest.version), 'component directory', manifest.id)
  const artifactPath = safeRootPath(componentDir, entry, label, manifest.id)
  if (!existsSync(artifactPath) || statSync(artifactPath).isDirectory()) throw stageError('artifact', manifest.id, `${label} is missing: ${entry}`)
  let realComponent: string; let realArtifact: string
  try { realComponent = realpathSync(componentDir); realArtifact = realpathSync(artifactPath) } catch (error) { throw stageError('artifact', manifest.id, `${label} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`) }
  const escaped = relative(realComponent, realArtifact)
  if (!escaped || escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw stageError('artifact', manifest.id, `${label} realpath escapes component directory`)
  const source = readFileSync(realArtifact)
  const sourceText = source.toString('utf8')
  if (/(?:node:[\w-]+|(?:import|export)\s+(?:[^'\"]+\s+from\s+)?['\"](?:assert|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|https|module|net|os|path|perf_hooks|process|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:\/[^'\"]*)?['\"]|require\s*\(|module\.exports|exports\.[A-Za-z_$]|process\.|Deno\.|\.so\b|\.dll\b|\.dylib\b|\.node\b|\.dex\b|Termux)/i.test(sourceText)) throw stageError('artifact', manifest.id, `${label} contains forbidden Node/CommonJS/native reference`)
  // Integrity covers this one file only, so dependency-loading syntax would
  // execute bytes that were never hashed. import.meta remains valid ESM.
  if (/(?:\bimport\s*(?:(?:[^'\"]|\n|\r)*?\sfrom\s*)?['\"][^'\"]+['\"]|\bexport\s+(?:(?:[^'\"]|\n|\r)*?\sfrom\s*)['\"][^'\"]+['\"]|\bimport\s*\()/i.test(sourceText)) throw stageError('artifact', manifest.id, `${label} must be a single-file portable ESM entry; bundle with the StageCraft CLI before checking`)
  const actual = `sha256-${createHash('sha256').update(source).digest('hex')}`
  if (expected !== actual) throw stageError('artifact', manifest.id, `${label} integrity mismatch: expected ${expected}, got ${actual}`)
  return realArtifact
}

function safeRootPath(root: string, child: string, label: string, coreId?: string): string {
  if (!isPortableRelativePath(child) && child !== 'manifest.json') throw stageError('path', coreId, `${label} must be a root-contained relative path: ${child}`)
  const candidate = resolve(root, child); const rel = relative(resolve(root), candidate)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw stageError('path', coreId, `${label} escapes its root: ${child}`)
  return candidate
}

function adaptCoreExport(value: unknown, manifest: ComponentManifest): HostCoreEntry {
  if (value && typeof value === 'object' && typeof (value as HostCoreEntry).boot === 'function') return value as HostCoreEntry
  // M2 defineCore adapter: maps registerCommand/ready into the M4 generic invoke surface.
  if (value && typeof value === 'object' && (value as { kind?: string }).kind === 'core' && typeof (value as { start?: unknown }).start === 'function') {
    const plugin = value as { manifest: { id: string; version: string }; start: (context: M2CoreContext) => void | Promise<void>; stop?: (context: M2CoreContext) => void | Promise<void> }
    if (!plugin.manifest || plugin.manifest.id !== manifest.id || plugin.manifest.version !== manifest.version) throw new Error(`M2 Core manifest identity mismatch: expected ${manifest.id}@${manifest.version}, got ${plugin.manifest?.id ?? 'missing'}@${plugin.manifest?.version ?? 'missing'}`)
    const commands = new Map<string, (input: unknown) => unknown | Promise<unknown>>()
    let authoringContext: M2CoreContext | undefined
    return {
      async boot(context) {
        authoringContext = {
          apiVersion: HOST_CORE_ABI_VERSION, pluginId: manifest.id, config: {},
          components: context.components,
          log(level, message, details) { void context.host.call('host.log', { level, message, details }, { pluginId: manifest.id, version: manifest.version }).catch(() => undefined) },
          registerCommand(name, handler) { if (commands.has(name)) throw new Error(`duplicate core command: ${name}`); commands.set(name, handler) },
          ready() { context.ready() },
        }
        await plugin.start(authoringContext)
      },
      async invoke(operation, input) { const handler = commands.get(operation); if (!handler) throw new Error(`unknown Core operation: ${operation}`); return handler(input) },
      async shutdown() { if (plugin.stop && authoringContext) await plugin.stop(authoringContext) },
    }
  }
  throw new Error(`default export is not a v2 Core or adaptable M2 defineCore plugin (${manifest.id})`)
}

interface M2CoreContext {
  apiVersion: string
  pluginId: string
  config: Readonly<Record<string, unknown>>
  readonly components?: readonly LoadedCoreComponent[]
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: unknown): void
  registerCommand(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void
  ready(): void
}

interface HostPortOptions {
  diagnostics: string[]
  grants: ReadonlyMap<string, ReadonlySet<string>>
  storage: ComponentStoragePort
}

/** Per-capability authorization: every operation maps to a capability that the
 * identified caller must have been granted during negotiation; unknown
 * operations, unidentified callers and ungranted capabilities all fail closed. */
function createHostPort(options: HostPortOptions): { call(operation: string, input: unknown, caller?: HostPortCaller): Promise<unknown> } {
  return { async call(operation, input, caller) {
    const capability = capabilityForHostOperation(operation)
    if (!capability) throw new Error(`Host operation denied: ${operation}`)
    if (!caller || typeof caller.pluginId !== 'string' || !caller.pluginId) throw new Error(`Host operation ${operation} requires a caller identity`)
    const granted = options.grants.get(caller.pluginId)
    if (!granted || !granted.has(capability)) throw new Error(`Host capability denied: ${capability} for ${caller.pluginId}`)
    if (operation === 'host.log') { options.diagnostics.push(`host.log: ${JSON.stringify(input)}`); return { ok: true } }
    const body = (input ?? {}) as { area?: unknown; value?: unknown }
    if (operation === 'host.storage.read') return { ok: true, value: await options.storage.read(caller, String(body.area ?? '')) ?? null }
    if (operation === 'host.storage.write') { await options.storage.write(caller, String(body.area ?? ''), body.value); return { ok: true } }
    throw new Error(`Host operation denied: ${operation}`)
  } }
}

function createHttpServer(session: HostCoreSession, plan: ComponentLaunchPlan, manifest: ComponentManifest, diagnostics: readonly string[], uiEntries: readonly { id: string; version: string; path: string }[], maxBodyBytes: number): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      if (request.method === 'GET' && url.pathname === '/api/v2/core/status') {
        sendJson(response, 200, { ok: session.state === 'ready', state: session.state, core: { id: manifest.id, version: manifest.version }, planHash: plan.planHash, diagnostics, uiEntries: uiEntries.map(entry => ({ id: entry.id, version: entry.version, url: `/api/v2/components/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.version)}/ui` })) })
        return
      }
      if (request.method === 'GET') {
        const ui = uiEntries.find(entry => url.pathname === `/api/v2/components/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.version)}/ui`)
        if (ui) { response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(readFileSync(ui.path)); return }
      }
      if (request.method === 'POST' && url.pathname === '/api/v2/core/invoke') {
        const body = await readBody(request, maxBodyBytes)
        if (!body || typeof body !== 'object' || typeof (body as { operation?: unknown }).operation !== 'string' || !(body as { operation: string }).operation) throw httpError(400, 'invalid_json', 'body must contain a non-empty operation')
        const result = await session.invoke((body as { operation: string }).operation, (body as { input?: unknown }).input)
        sendJson(response, 200, { ok: true, result })
        return
      }
      sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Not found' } })
    } catch (error) {
      const failure = error as HttpFailure
      sendJson(response, failure.status ?? 500, { ok: false, error: { code: failure.code ?? 'internal_error', message: failure.message ?? String(error) } })
    }
  })
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const length = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(length) && length > maxBytes) throw httpError(413, 'body_too_large', `request body exceeds ${maxBytes} bytes`)
  const chunks: Buffer[] = []; let total = 0
  for await (const chunk of request) { const bytes = Buffer.from(chunk); total += bytes.length; if (total > maxBytes) throw httpError(413, 'body_too_large', `request body exceeds ${maxBytes} bytes`); chunks.push(bytes) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw httpError(400, 'invalid_json', 'request body must be valid JSON') }
}

interface HttpFailure extends Error { status?: number; code?: string }
function httpError(status: number, code: string, message: string): HttpFailure { const error = new Error(message) as HttpFailure; error.status = status; error.code = code; return error }
function sendJson(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)) }
function listen(server: Server, port: number, host: string): Promise<void> { return new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, () => resolveListen()) }) }
function stopServer(server: Server): Promise<void> { return new Promise(resolveClose => { if (!server.listening) { resolveClose(); return }; server.close(() => resolveClose()) }) }
async function disposeEntry(entry: HostCoreEntry): Promise<void> { if (entry.shutdown) await entry.shutdown() }
async function cleanupEntry(entry: HostCoreEntry, session: HostCoreSession): Promise<void> {
  let cleanupError: unknown
  try { await disposeEntry(entry) } catch (error) { cleanupError = error }
  finally {
    if (session.state !== 'shutdown' && session.state !== 'failed') session.shutdown()
  }
  if (cleanupError) throw cleanupError
}
function stageError(stage: string, coreId: string | undefined, message: string): Error { return new Error(`[v2:${stage}${coreId ? `/${coreId}` : ''}] ${message}`) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function immutableJson<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value as Record<string, unknown>)) immutableJson(child)
  return Object.freeze(value)
}

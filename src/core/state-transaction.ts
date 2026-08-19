import { isDeepStrictEqual } from 'node:util'

export type StatePatch =
  | { op: 'set' | 'replace'; path: string; value: unknown }
  | { op: 'delta'; path: string; value: number }
  | { op: 'insert'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move'; from: string; path: string }
  | { op: 'merge'; path: string; value: Record<string, unknown> }
  | { op: 'test'; path: string; value: unknown }

export interface StateChange {
  path: string
  before: unknown
  after: unknown
}

export interface StatePatchResult<T = unknown> {
  before: T
  after: T
  changes: StateChange[]
}

export interface StateModuleManifest {
  id: string
  version: string
  label?: string
}

export interface StateSchemaDefinition {
  id: string
  moduleId: string
  validate(state: unknown): void | string[]
}

export interface StateReducerEvent {
  id: string
  type: string
  payload?: unknown
}

export interface StateReducerResult {
  patches?: StatePatch[]
  events?: StateReducerEvent[]
}

export interface StateReducer {
  id: string
  moduleId: string
  priority?: number
  listensTo?: string[]
  match?(event: StateReducerEvent): boolean
  reduce(state: unknown, event: StateReducerEvent): StateReducerResult | StatePatch[] | void
}

export interface StateTransactionTrace {
  events: StateReducerEvent[]
  reducers: string[]
  changes: StateChange[]
  assertions: StatePatch[]
}

export interface StateTransactionRequest {
  roomId: string
  moduleId?: string
  baseRevision?: number
  patches?: StatePatch[]
  assertions?: StatePatch[]
  events?: StateReducerEvent[]
  system?: boolean
  traceId?: string
}

export interface TransitionResult<T = Record<string, unknown>> {
  roomId: string
  revision: number
  before: T
  after: T
  changes: StateChange[]
  assertions: StatePatch[]
  trace: StateTransactionTrace
}

export type StateTransactionResult = TransitionResult<Record<string, unknown>>

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])

function clone<T>(value: T): T {
  return structuredClone(value)
}

function encode(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

function decode(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${path}`)
  return path.slice(1).split('/').map(segment => {
    if (/~(?![01])/.test(segment)) throw new Error(`Invalid JSON Pointer escape: ${segment}`)
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (FORBIDDEN.has(decoded)) throw new Error(`Forbidden state path segment: ${decoded}`)
    return decoded
  })
}

function indexFor(value: unknown[], segment: string, allowEnd = false): number {
  if (segment === '-' && allowEnd) return value.length
  if (!/^(?:0|[1-9]\d*)$/.test(segment)) throw new Error(`Invalid array index: ${segment}`)
  const index = Number(segment)
  if (!Number.isSafeInteger(index) || index < 0 || index > value.length || (!allowEnd && index >= value.length)) throw new Error(`Array index out of bounds: ${segment}`)
  return index
}

function read(root: unknown, segments: string[]): unknown {
  let current = root
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[indexFor(current, segment)]
    else if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) current = (current as Record<string, unknown>)[segment]
    else throw new Error(`State path does not exist: /${segments.map(encode).join('/')}`)
  }
  return current
}

function parent(root: unknown, segments: string[], create = false): { target: Record<string, unknown> | unknown[]; key: string } {
  if (segments.length === 0) throw new Error('Root has no parent.')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) current = current[indexFor(current, segment)]
    else if (current !== null && typeof current === 'object') {
      const object = current as Record<string, unknown>
      if (!Object.prototype.hasOwnProperty.call(object, segment)) {
        if (!create) throw new Error(`State path does not exist: /${segments.map(encode).join('/')}`)
        object[segment] = {}
      }
      current = object[segment]
    } else throw new Error('Cannot traverse a non-object state path.')
  }
  if (!Array.isArray(current) && (current === null || typeof current !== 'object')) throw new Error('State path parent is not an object or array.')
  return { target: current as Record<string, unknown> | unknown[], key: segments[segments.length - 1] }
}

function replaceRoot(root: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return clone(value)
  const { target, key } = parent(root, segments, true)
  if (Array.isArray(target)) target[indexFor(target, key)] = clone(value)
  else target[key] = clone(value)
  return root
}

function setPath(root: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return clone(value)
  const { target, key } = parent(root, segments, true)
  if (Array.isArray(target)) {
    const index = indexFor(target, key, true)
    if (index === target.length) target.push(clone(value))
    else target[index] = clone(value)
  } else target[key] = clone(value)
  return root
}

function insertPath(root: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) throw new Error('Insert at the root is not supported.')
  const { target, key } = parent(root, segments)
  if (!Array.isArray(target)) throw new Error(`Insert target is not an array: /${segments.map(encode).join('/')}`)
  target.splice(indexFor(target, key, true), 0, clone(value))
  return root
}

function applyOne(root: unknown, patch: StatePatch): unknown {
  if (patch.op === 'test') {
    if (!isDeepStrictEqual(read(root, decode(patch.path)), patch.value)) throw new Error(`State test failed at ${patch.path}`)
    return root
  }
  if (patch.op === 'move') {
    const from = decode(patch.from)
    const destination = decode(patch.path)
    if (from.length === 0 || destination.length === 0) throw new Error('Moving the root is not supported.')
    if (patch.from === patch.path) throw new Error('Moving a path onto itself is not supported.')
    if (patch.path.startsWith(`${patch.from}/`)) throw new Error('Moving a path into its own child is not supported.')
    const value = clone(read(root, from))
    root = applyOne(root, { op: 'remove', path: patch.from })
    const { target, key } = parent(root, destination)
    if (Array.isArray(target)) target.splice(indexFor(target, key, true), 0, value)
    else {
      // Object moves replace an existing destination key, matching JSON Patch's
      // add semantics. This also makes array-to-object and object-to-array
      // moves explicit: the destination container determines the operation.
      target[key] = value
    }
    return root
  }
  const segments = decode(patch.path)
  if (patch.op === 'set' || patch.op === 'replace') {
    if (patch.op === 'replace' && segments.length > 0) read(root, segments)
    return patch.op === 'set' ? setPath(root, segments, patch.value) : replaceRoot(root, segments, patch.value)
  }
  if (patch.op === 'delta') {
    const current = read(root, segments)
    if (typeof current !== 'number' || !Number.isFinite(current) || !Number.isFinite(patch.value)) throw new Error(`Delta target/value is not finite: ${patch.path}`)
    return replaceRoot(root, segments, current + patch.value)
  }
  if (patch.op === 'merge') {
    const current = read(root, segments)
    if (current === null || typeof current !== 'object' || Array.isArray(current)) throw new Error(`Merge target is not an object: ${patch.path}`)
    return replaceRoot(root, segments, { ...(current as Record<string, unknown>), ...clone(patch.value) })
  }
  if (patch.op === 'remove' && segments.length === 0) return undefined
  if (patch.op === 'insert') {
    return insertPath(root, segments, patch.value)
  } else if (patch.op === 'remove') {
    const { target, key } = parent(root, segments)
    if (Array.isArray(target)) target.splice(indexFor(target, key), 1)
    else if (Object.prototype.hasOwnProperty.call(target, key)) delete target[key]
    else throw new Error(`State path does not exist: ${patch.path}`)
  }
  return root
}

function diff(before: unknown, after: unknown, path = ''): StateChange[] {
  if (isDeepStrictEqual(before, after)) return []
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    const changes: StateChange[] = []
    if (Array.isArray(before) && Array.isArray(after)) {
      const length = Math.max(before.length, after.length)
      for (let index = 0; index < length; index++) changes.push(...diff(before[index], after[index], `${path}/${index}`))
    } else {
      const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)])
      for (const key of keys) changes.push(...diff((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], `${path}/${encode(key)}`))
    }
    return changes
  }
  return [{ path: path || '', before: clone(before), after: clone(after) }]
}

export function applyStatePatches<T>(input: T, patches: StatePatch[]): StatePatchResult<T> {
  const before = clone(input)
  let after: unknown = clone(input)
  for (const patch of patches) after = applyOne(after, patch)
  return { before, after: after as T, changes: diff(before, after) }
}

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { StoryPackage } from './story-packages.ts'
import { validateStoryPackage } from './story-packages.ts'

export interface StoryArchiveEntry { name: string; data: Uint8Array }

const MAX_FILES = 256
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const ALLOWED_ASSET = /\.(?:png|jpe?g|webp|gif|svg)$/i

export function collectStoryArchiveEntries(story: StoryPackage, assetsDir: string): StoryArchiveEntry[] {
  const portableStory = JSON.parse(JSON.stringify(story)) as StoryPackage & { playerCharacter?: { portraitRef?: string }; roles: Array<{ portraitRef?: string }> }
  const rewrite = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && key === 'portraitRef') (value as Record<string, unknown>)[key] = item.replace(new RegExp(`^/story-assets/${story.id}/`), 'assets/')
      else if (item && typeof item === 'object') rewrite(item)
    }
  }
  rewrite(portableStory)
  const storyBytes = Buffer.from(`${JSON.stringify(portableStory, null, 2)}\n`, 'utf8')
  const manifest = Buffer.from(`${JSON.stringify({ format: 'stagecraft-story', version: 1, storyFile: 'story.json', assetRoot: 'assets/' }, null, 2)}\n`, 'utf8')
  const entries: StoryArchiveEntry[] = [{ name: 'manifest.json', data: manifest }, { name: 'story.json', data: storyBytes }]
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name)
      const info = statSync(absolute)
      if (info.isDirectory()) { walk(absolute); continue }
      const rel = relative(assetsDir, absolute).split(sep).join('/')
      if (!rel || rel.startsWith('../') || !ALLOWED_ASSET.test(rel)) continue
      entries.push({ name: `assets/${rel}`, data: readFileSync(absolute) })
      if (entries.length > MAX_FILES) throw new Error('剧本资源文件过多。')
    }
  }
  try { walk(assetsDir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const total = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0)
  if (total > MAX_TOTAL_BYTES) throw new Error('剧本包解压后超过 64 MB。')
  return entries
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function importStoryArchive(buffer: Uint8Array, directory: string, id: string): StoryPackage {
  const bytes = Buffer.from(buffer); if (bytes.length > MAX_TOTAL_BYTES) throw new Error('剧本包过大。')
  const entries: StoryArchiveEntry[] = []
  let offset = 0
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = bytes.readUInt16LE(offset + 26); const compressedLength = bytes.readUInt32LE(offset + 18); const expectedLength = bytes.readUInt32LE(offset + 22); const method = bytes.readUInt16LE(offset + 8); const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\') || entries.some(item => item.name === name)) throw new Error('剧本包包含不安全或重复文件名。')
    const start = offset + 30 + nameLength; const end = start + compressedLength; if (end > bytes.length) throw new Error('剧本包损坏。')
    const data = method === 0 ? bytes.subarray(start, end) : method === 8 ? inflateRawSync(bytes.subarray(start, end), { maxOutputLength: MAX_TOTAL_BYTES }) : null
    if (!data || data.length !== expectedLength) throw new Error('剧本包使用了不支持或损坏的压缩格式。')
    entries.push({ name, data }); offset = end
    if (entries.length > MAX_FILES || entries.reduce((total, item) => total + item.data.byteLength, 0) > MAX_TOTAL_BYTES) throw new Error('剧本包解压后过大。')
  }
  const manifest = entries.find(item => item.name === 'manifest.json'); const storyEntry = entries.find(item => item.name === 'story.json')
  const manifestValue = manifest ? JSON.parse(Buffer.from(manifest.data).toString('utf8')) as Record<string, unknown> : null
  if (!storyEntry || manifestValue?.format !== 'stagecraft-story' || manifestValue.version !== 1 || manifestValue.storyFile !== 'story.json' || manifestValue.assetRoot !== 'assets/') throw new Error('不是有效的 StageCraft 剧本包。')
  const story = JSON.parse(Buffer.from(storyEntry.data).toString('utf8')) as StoryPackage
  const rewrite = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && key === 'portraitRef') (value as Record<string, unknown>)[key] = item.startsWith('assets/') ? `/story-assets/${id}/${item.slice(7)}` : item.replace(/^\/story-assets\/[^/]+\//, `/story-assets/${id}/`)
      else if (item && typeof item === 'object') rewrite(item)
    }
  }
  story.id = id; rewrite(story)
  validateStoryPackage(story)
  const assetEntries = entries.filter(item => item.name.startsWith('assets/'))
  for (const entry of assetEntries) { const relativeName = entry.name.slice(7); if (!relativeName || !ALLOWED_ASSET.test(relativeName)) throw new Error('剧本包包含不支持的资源类型。') }
  const target = join(directory, 'custom'); mkdirSync(target, { recursive: true }); writeFileSync(join(target, `${id}.json`), `${JSON.stringify(story, null, 2)}\n`, 'utf8')
  const assets = join(target, `${id}.assets`); for (const entry of assetEntries) { const relativeName = entry.name.slice(7); mkdirSync(dirname(join(assets, relativeName)), { recursive: true }); writeFileSync(join(assets, relativeName), entry.data) }
  return story
}

export function createStoredZip(entries: StoryArchiveEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

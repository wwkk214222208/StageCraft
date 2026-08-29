#!/usr/bin/env node
/**
 * 构建期生成 api-route-registry.json 资产（Q6/CP-W1：生成物是证据，不是截图）。
 * Java gateway 按 method 精确、静态优先、歧义失败语义消费该文件。
 * 用法：node --experimental-strip-types scripts/generate-api-route-registry.mjs [输出路径]
 * 默认输出 android/app/src/main/assets/api-route-registry.json。
 * 产物与 generateRegistryJson() 逐字节一致，由 test/api-route-registry.test.ts 强制。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateRegistryJson } from '../src/api-route-registry.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = process.argv[2] ?? path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'api-route-registry.json')

await mkdir(path.dirname(outPath), { recursive: true })
await writeFile(outPath, generateRegistryJson(), 'utf8')
console.log(`written ${outPath}`)

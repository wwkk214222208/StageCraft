#!/usr/bin/env node
/**
 * W6-2：构建期插件目录生成器。
 * 从 Android 内置插件候选集（src/portable/android-local-core.ts 的 BUILTIN_PLUGIN_MANIFESTS）
 * 生成确定性 plugin-manifest.json 资产，供主进程 PluginManager 构建真实 launch plan
 * （id/version/manifestHash 非占位；与 :core 组合根校验同一来源）。
 *
 * 用法：node --experimental-strip-types scripts/generate-plugin-manifest.mjs [输出路径]
 * 默认输出 android/app/src/main/assets/plugin-manifest.json。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_PLUGIN_MANIFESTS } from '../src/portable/android-local-core.ts'
import { manifestHash } from '../src/plugin-bootstrap.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = process.argv[2] ?? path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'plugin-manifest.json')

const catalog = {
  catalogVersion: '1.0.0',
  plugins: [...BUILTIN_PLUGIN_MANIFESTS]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(manifest => ({
      id: manifest.id,
      version: manifest.version,
      kind: manifest.kind,
      title: manifest.title,
      manifestHash: manifestHash(manifest),
    })),
}

await mkdir(path.dirname(outPath), { recursive: true })
await writeFile(outPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8')
console.log(`written ${outPath} (${catalog.plugins.length} plugins)`)

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '..')
const distRoot = join(packageRoot, 'dist')
const publicRoot = join(distRoot, 'public')

rmSync(distRoot, { recursive: true, force: true })
mkdirSync(publicRoot, { recursive: true })

buildSync({
  entryPoints: {
    index: join(packageRoot, 'src', 'index.ts'),
    worker: join(repositoryRoot, 'src', 'debug', 'stagecraft-worker.ts'),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: distRoot,
  sourcemap: true,
  packages: 'external',
  external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
  legalComments: 'eof',
})

const sourcePublic = join(repositoryRoot, 'public')
const publicFiles = [
  'app.js',
  'core-client.js',
  'core-interactions.css',
  'core-interactions.js',
  'style.css',
  'index.html',
]
for (const file of publicFiles) cpSync(join(sourcePublic, file), join(publicRoot, file))
for (const file of ['default.svg', 'rowan.svg', 'seraphina.png', 'vex.svg', 'stagecraft-logo.png']) {
  cpSync(join(sourcePublic, 'assets', file), join(publicRoot, 'assets', file))
}

mkdirSync(join(distRoot, 'stories'), { recursive: true })
mkdirSync(join(distRoot, 'prompts'), { recursive: true })
if (existsSync(join(repositoryRoot, 'prompts', 'gameplay'))) cpSync(join(repositoryRoot, 'prompts', 'gameplay'), join(distRoot, 'prompts', 'gameplay'), { recursive: true })
// 默认剧本与示范资产目录（stories/default/，自包含 /story-assets/eldoria/... 随包分发）
cpSync(join(repositoryRoot, 'stories', 'default'), join(distRoot, 'stories', 'default'), { recursive: true })
// prompts.json 已随 e1456f2 重构删除（内联 gameplay + SQLite 预设），保留存在性保护以兼容旧版
if (existsSync(join(repositoryRoot, 'prompts', 'prompts.json'))) {
  cpSync(join(repositoryRoot, 'prompts', 'prompts.json'), join(distRoot, 'prompts', 'prompts.json'))
}
cpSync(join(repositoryRoot, 'providers.example.json'), join(distRoot, 'providers.example.json'))
cpSync(join(repositoryRoot, 'LICENSE'), join(distRoot, 'LICENSE'))
cpSync(join(repositoryRoot, 'NOTICE.md'), join(distRoot, 'NOTICE.md'))
cpSync(join(repositoryRoot, 'LICENSE'), join(packageRoot, 'LICENSE'))
cpSync(join(repositoryRoot, 'NOTICE.md'), join(packageRoot, 'NOTICE.md'))
const sourceCommit = process.env.SOURCE_COMMIT ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }).toString().trim()
const sourceUrl = process.env.SOURCE_REPOSITORY_URL ?? 'UNSET: publisher must provide the public source URL before redistribution.'
writeFileSync(join(distRoot, 'SOURCE.md'), [
  '# StageCraft source',
  '',
  'This DSH bundle is AGPL-3.0-only.',
  `Corresponding source commit: ${sourceCommit}`,
  `Corresponding source URL: ${sourceUrl}`,
  '',
  'If the source URL is UNSET, this is a development artifact and must not be redistributed until the publisher provides a public source location.',
  '',
  'The bundle contains generated JavaScript from the repository source. It does not include private data, custom media, or local saves.',
  '',
].join('\n'))

console.log(`Built DSH bundle at ${distRoot}`)

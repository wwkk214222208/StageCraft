import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = join(repositoryRoot, 'dsh-rp')

test('packed DSH bundle is self-contained and runs from a temporary install', async () => {
  execFileSync(process.execPath, ['dsh-rp/scripts/build.mjs'], { cwd: repositoryRoot, stdio: 'inherit' })
  const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'stagecraft-dsh-pack-'))
  try {
    const npmCommand = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
    const npmArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm pack --json']
      : ['pack', '--json']
    const packJson = execFileSync(npmCommand, npmArgs, {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(repositoryRoot, '.npm-cache') },
    })
    const metadata = JSON.parse(packJson)[0] as { filename: string; files: { path: string }[] }
    // The repository and the system temp directory may be on different
    // volumes (notably D: and C: on Windows), so rename is not portable.
    copyFileSync(join(packageRoot, metadata.filename), join(tempRoot, metadata.filename))
    rmSync(join(packageRoot, metadata.filename), { force: true })
    const files = metadata.files.map(item => item.path)
    assert.ok(files.includes('LICENSE'))
    assert.ok(files.includes('NOTICE.md'))
    assert.ok(files.includes('cordis.patch.yml'))
    assert.ok(files.includes('dist/index.js'))
    assert.ok(files.includes('dist/SOURCE.md'))
    assert.ok(files.includes('dist/public/index.html'))
    assert.ok(files.includes('dist/stories/eldoria.json'))
    assert.ok(files.every(file => !/(^|\/)(custom|data|save)(\/|$)/.test(file)))
    assert.ok(files.every(file => !file.endsWith('.ts')))
    assert.doesNotMatch(files.join('\n'), /命定之诗/)

    const archivePath = join(tempRoot, metadata.filename)
    execFileSync('tar', ['-xzf', archivePath, '-C', tempRoot])
    const installRoot = join(tempRoot, 'package')
    symlinkSync(join(repositoryRoot, 'node_modules'), join(installRoot, 'node_modules'), 'junction')
    const bundleEntry = await import(pathToFileURL(join(installRoot, 'dist', 'index.js')).href + '?test=' + Date.now())
    assert.deepEqual(Object.keys(bundleEntry).sort(), ['Config', 'apply', 'inject', 'name'])
    assert.equal(bundleEntry.name, 'rp')
    assert.deepEqual(bundleEntry.inject, [])
    const bundledSource = readFileSync(join(installRoot, 'dist', 'index.js'), 'utf8')
    assert.doesNotMatch(bundledSource, /(?:from|import\()\s*["'][^"']*\.ts/)
    assert.doesNotMatch(bundledSource, /\.\.\/\.\.\/src/)
    assert.doesNotMatch(bundledSource, /命定之诗/)
    assert.doesNotMatch(readFileSync(join(installRoot, 'dist', 'public', 'index.html'), 'utf8'), /DeepPlugin HARNESS|M22\.9168/)
    assert.doesNotMatch(readFileSync(join(installRoot, 'dist', 'public', 'index.html'), 'utf8'), /命定之诗/)

    const port = 18_000 + Math.floor(Math.random() * 500)
    const ctx = new Context()
    const fiber = ctx.plugin(bundleEntry, { port, host: '127.0.0.1' })
    try {
      await fiber
      const response = await fetch('http://127.0.0.1:' + port + '/api/room')
      assert.equal(response.status, 200)
    } finally {
      await fiber.dispose()
    }
    await assert.rejects(fetch('http://127.0.0.1:' + port + '/api/room'))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

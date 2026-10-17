import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const digest = data => createHash('sha256').update(data).digest('hex')

export async function buildWindowsSandbox() {
  if (process.platform !== 'win32') return
  const inputs = join(root, 'native/srt-win-patch')
  const pin = JSON.parse(await readFile(join(inputs, 'SOURCE.json'), 'utf8'))
  const patch = await readFile(join(inputs, 'acl-parent.patch'))
  if (digest(patch) !== pin.patchSha256) throw new Error('SRT_PATCH_HASH_MISMATCH')
  const directory = await mkdtemp(join(tmpdir(), 'pulse-srt-build-'))
  function run(command, args, cwd = directory) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`SRT_BUILD_FAILED: ${command} (${result.status})`)
  }
  try {
    const response = await fetch(pin.archiveUrl, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`SRT_SOURCE_DOWNLOAD_FAILED:${response.status}`)
    const archive = Buffer.from(await response.arrayBuffer())
    if (digest(archive) !== pin.archiveSha256) throw new Error('SRT_SOURCE_HASH_MISMATCH')
    const source = join(directory, 'source')
    await mkdir(source)
    await writeFile(join(directory, 'source.tar.gz'), archive)
    await writeFile(join(directory, 'native.patch'), patch)
    run('tar', ['-xzf', join(directory, 'source.tar.gz'), '-C', source, '--strip-components=1'])
    run('git', ['apply', '--check', join(directory, 'native.patch')], source)
    run('git', ['apply', join(directory, 'native.patch')], source)
    const manifest = join(source, 'vendor/srt-win-src/Cargo.toml')
    // Native tests exercise real NTFS ACL evaluation, multiple holders and
    // rollback. They must pass before this binary can enter a release artifact.
    run('cargo', ['test', '--locked', '--release', '--manifest-path', manifest], source)
    run('cargo', ['build', '--locked', '--release', '--manifest-path', manifest], source)
    const executable = join(source, 'vendor/srt-win-src/target/release/srt-win.exe')
    const destination = join(root, 'packages/adapters/dist/native')
    await mkdir(destination, { recursive: true })
    await cp(executable, join(destination, 'srt-win.exe'))
    await cp(join(inputs, 'LICENSE'), join(destination, 'LICENSE'))
    const sha256 = digest(await readFile(executable))
    await writeFile(join(destination, 'srt-win.json'), JSON.stringify({ ...pin, sha256 }, null, 2) + '\n')
    console.log(`Windows sandbox native tests and build passed (${sha256}).`)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

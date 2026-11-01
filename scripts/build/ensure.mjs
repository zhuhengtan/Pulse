import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const packages = ['data', 'runtime', 'tool-sdk', 'adapters', 'server', 'cli', 'web']
const hash = value => createHash('sha256').update(value).digest('hex')
const ignored = new Set(['node_modules', 'dist', 'target', '.git', '.cache', '__pycache__'])
async function inventory(root, paths, exclude = false) {
  const files = []
  async function visit(path) {
    const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) { files.push([relative(root, path).replaceAll('\\', '/'), null]); return }
    if (info.isDirectory()) {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (exclude && (ignored.has(entry.name) || entry.name.endsWith('.tsbuildinfo'))) continue
        const child = join(path, entry.name)
        if (entry.isSymbolicLink()) files.push([relative(root, child).replaceAll('\\', '/'), 'link:' + await readlink(child)])
        else await visit(child)
      }
    } else files.push([relative(root, path).replaceAll('\\', '/'), hash(await readFile(path))])
  }
  for (const path of paths) await visit(join(root, path))
  return files
}
async function toolchain(root) {
  const versions = {}
  for (const name of ['typescript', 'vite', 'pnpm']) {
    const directories = name === 'vite' ? ['packages/web/node_modules', 'node_modules'] : ['node_modules']
    for (const directory of directories) {
      try { versions[name] = JSON.parse(await readFile(join(root, directory, name, 'package.json'), 'utf8')).version; break } catch { /* absent optional tool path */ }
    }
  }
  const manager = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
  versions.pnpm = manager.status === 0 ? manager.stdout.trim() : 'unavailable'
  return { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, versions }
}
export async function buildFingerprint(root, identity) {
  const rootFiles = (await readdir(root)).filter(name => /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig.*\.json|CHANGELOG(?:\.en)?\.md|\.npmrc)$/.test(name))
  const inputs = await inventory(root, [...rootFiles.sort(), 'packages', 'scripts', 'native'], true)
  const flags = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'NODE_ENV' || key.startsWith('VITE_')).sort(([a], [b]) => a.localeCompare(b)))
  return hash(JSON.stringify({ inputs, identity: identity ?? await toolchain(root), flags }))
}
export function outputPaths(kind) {
  if (kind === 'web') return ['packages/web/dist', 'packages/server/dist/web']
  if (kind === 'workspace') return packages.map(name => `packages/${name}/dist`)
  throw Error('INVALID_BUILD_KIND')
}
async function outputDigest(root, outputs) {
  const groups = await Promise.all(outputs.map(output => inventory(root, [output])))
  if (groups.some(files => files.some(([, digest]) => digest === null) || !files.some(([, digest]) => digest && !digest.startsWith('link:')))) return undefined
  return hash(JSON.stringify(groups.flat()))
}
function execute(root, command, args) {
  const started = Date.now()
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' && command === 'pnpm' })
  console.log(`[build] ${command} ${args.join(' ')} ${Date.now() - started}ms`)
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`BUILD_FAILED:${command}:${result.status ?? result.signal}`)
}
export async function ensureBuild(kind = 'workspace', options = {}) {
  const root = resolve(options.root ?? repository), outputs = options.outputs ?? outputPaths(kind)
  const run = options.run ?? ((command, args) => execute(root, command, args))
  const cache = join(root, '.pulse-dev', 'build-state'), lock = join(cache, 'lock')
  await mkdir(cache, { recursive: true })
  const waiting = Date.now()
  while (true) {
    try { await mkdir(lock); await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid })); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = await readFile(join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => undefined)
      if (Number.isSafeInteger(owner?.pid)) {
        try { process.kill(owner.pid, 0) } catch (cause) { if (cause.code === 'ESRCH') throw Error('BUILD_LOCK_STALE: remove .pulse-dev/build-state/lock only after checking no build is running') }
      }
      if (Date.now() - waiting > 180000) throw Error('BUILD_LOCK_BUSY')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try {
    // Preserve the standalone build command's changelog generation behavior.
    if (kind === 'workspace') await run(process.execPath, ['scripts/release/sync-cli-highlights.mjs'])
    const input = await buildFingerprint(root, options.identity), file = join(cache, kind + '.json')
    const previous = await readFile(file, 'utf8').then(JSON.parse).catch(() => undefined)
    if (previous?.schema === 1 && previous.input === input && previous.output && previous.output === await outputDigest(root, outputs)) {
      console.log(`[build] ${kind}: verified reuse`)
      return { reused: true, input, output: previous.output }
    }
    if (options.build) await options.build()
    else {
      // Rebuild owned outputs from source, including removals and tampering.
      // Native executables are prepared and integrity-checked separately.
      for (const output of outputPaths(kind)) {
        const directory = join(root, output)
        for (const entry of await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
          if (entry !== 'native') await rm(join(directory, entry), { recursive: true, force: true })
        }
      }
      await run(process.execPath, ['node_modules/typescript/bin/tsc', '-b', ...(kind === 'web' ? ['packages/server'] : []), '--force', '--pretty', 'false'])
      await run(process.execPath, ['scripts/build/copy-adapter-assets.mjs'])
      await run('pnpm', ['--filter', '@hunterzhu/pulse-web', 'build'])
      await run(process.execPath, ['scripts/web/stage.mjs'])
      const webDigest = await outputDigest(root, outputPaths('web'))
      if (!webDigest) throw Error('BUILD_OUTPUT_MISSING:web')
      if (input !== await buildFingerprint(root, options.identity)) throw Error('BUILD_INPUT_CHANGED')
      const webStamp = join(cache, 'web.json.' + process.pid)
      await writeFile(webStamp, JSON.stringify({ schema: 1, input, output: webDigest }) + '\n'); await rename(webStamp, join(cache, 'web.json'))
    }
    if (input !== await buildFingerprint(root, options.identity)) throw Error('BUILD_INPUT_CHANGED')
    const output = await outputDigest(root, outputs)
    if (!output) throw Error('BUILD_OUTPUT_MISSING:' + kind)
    const temporary = file + '.' + process.pid
    await writeFile(temporary, JSON.stringify({ schema: 1, input, output }) + '\n'); await rename(temporary, file)
    console.log(`[build] ${kind}: built and verified`)
    return { reused: false, input, output }
  } finally { await rm(lock, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await ensureBuild(process.argv[2] ?? 'workspace')

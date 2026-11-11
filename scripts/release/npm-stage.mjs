import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { copyProductionDependency, resolveInstalledPackage, sandboxPackage, verifySandboxBundle } from './dependency-bundle.mjs'

export const publicationOrder = ['data', 'runtime', 'tool-sdk', 'adapters', 'server', 'cli']
export function npmInvocation(args) {
  const nodeDirectory = dirname(process.execPath)
  const candidates = [join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'), join(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js')]
  try { candidates.push(join(dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin/npm-cli.js')) } catch { /* distro npm may not be on Node's module path */ }
  const cli = candidates.find(path => existsSync(path) && JSON.parse(readFileSync(join(dirname(path), '../package.json'), 'utf8')).name === 'npm')
  assert.ok(cli, 'NPM_CLI_NOT_FOUND_FOR_NODE')
  return { file: process.execPath, args: [realpathSync(cli), ...args] }
}
export function npmCommand(args, options = {}) {
  const invocation = npmInvocation(args)
  // Never pass package paths through cmd.exe (spaces and & are ordinary argv).
  const result = spawnSync(invocation.file, invocation.args, { encoding: 'utf8', ...options, shell: false })
  if (result.status !== 0) throw new Error(result.stderr || `NPM_COMMAND_FAILED:${args[0]}`)
  return result.stdout
}
function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'NPM_ARCHIVE_FAILED')
  return result.stdout
}
export function privatePathVariants(paths) {
  return [...new Set(paths.filter(value => value && value.length > 3).flatMap(value => {
    const slash = value.replaceAll('\\', '/')
    const url = /^[A-Za-z]:\//.test(slash) ? 'file:///' + slash.split('/').map((part, i) => i ? encodeURIComponent(part) : part).join('/') : pathToFileURL(value).href
    return [value, slash, url, JSON.stringify(value).slice(1, -1), JSON.stringify(slash).slice(1, -1)]
  }))]
}
export async function verifyNpmArchive(archive, destination, forbiddenPaths = []) {
  const entries = tar(['-tzf', archive]).trim().split('\n')
  assert.ok(entries.every(name => name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('\\')), 'UNSAFE_NPM_ARCHIVE_PATH')
  assert.ok(entries.every(name => !name.split('/').some(part => ['.bin', '.pnpm', '.git', '.package-lock.json'].includes(part))), 'PACKAGE_MANAGER_METADATA_IN_ARCHIVE')
  assert.ok(tar(['-tvzf', archive]).trim().split('\n').every(line => /^[d-]/.test(line)), 'LINK_OR_SPECIAL_FILE_IN_ARCHIVE')
  await mkdir(destination, { recursive: true })
  tar(['-xzf', archive, '-C', destination])
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) await inspect(file)
      else {
        const bytes = await readFile(file)
        for (const privatePath of privatePathVariants(forbiddenPaths)) assert.ok(!bytes.includes(Buffer.from(privatePath)), 'LOCAL_PATH_IN_NPM_PAYLOAD')
      }
    }
  }
  await inspect(destination)
  const root = join(destination, 'package'), data = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (data.name === '@hunterzhu/pulse-adapters') {
    assert.deepEqual(data.bundledDependencies, [sandboxPackage])
    await verifySandboxBundle(await resolveInstalledPackage(sandboxPackage, root))
  }
  return data
}

/** Stage, pack and inspect ALL six artifacts before any publication can begin. */
export async function stageNpmPackages(repo, stage) {
  const manifests = new Map()
  for (const name of publicationOrder) manifests.set(name, JSON.parse(await readFile(join(repo, `packages/${name}/package.json`), 'utf8')))
  const versions = new Map([...manifests.values()].map(data => [data.name, data.version]))
  await mkdir(join(stage, 'tarballs'), { recursive: true })
  const packages = []
  for (const name of publicationOrder) {
    const source = join(repo, `packages/${name}`), target = join(stage, name)
    await mkdir(target, { recursive: true })
    await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true })
    if (name === 'server') {
      await cp(join(repo, 'packages/web/dist'), join(target, 'dist/web'), { recursive: true })
      await cp(join(source, 'native'), join(target, 'native'), { recursive: true }).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    await cp(join(source, 'README.md'), join(target, 'README.md'))
    await cp(join(repo, 'LICENSE'), join(target, 'LICENSE'))
    if (name === 'cli') await cp(join(source, 'scripts'), join(target, 'scripts'), { recursive: true })
    const data = structuredClone(manifests.get(name))
    for (const dependencies of [data.dependencies, data.optionalDependencies, data.peerDependencies]) {
      for (const [dependency, value] of Object.entries(dependencies ?? {})) if (value === 'workspace:*' && versions.has(dependency)) dependencies[dependency] = versions.get(dependency)
    }
    await writeFile(join(target, 'package.json'), JSON.stringify(data, null, 2) + '\n')
    if (name === 'adapters') await copyProductionDependency(sandboxPackage, await resolveInstalledPackage(sandboxPackage, source), join(target, 'node_modules', sandboxPackage))
    const result = JSON.parse(npmCommand(['pack', target, '--ignore-scripts', '--json', '--pack-destination', join(stage, 'tarballs')], { cwd: stage }))
    assert.equal(result.length, 1)
    assert.match(result[0].filename, /^[a-zA-Z0-9._-]+\.tgz$/)
    const archive = join(stage, 'tarballs', result[0].filename)
    const packed = await verifyNpmArchive(archive, join(stage, 'verified', name), [repo, homedir(), userInfo().homedir])
    assert.equal(packed.name, data.name); assert.equal(packed.version, data.version)
    packages.push({ name: data.name, version: data.version, archive, integrity: result[0].integrity })
  }
  return packages
}

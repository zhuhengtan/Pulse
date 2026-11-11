import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export const sandboxPackage = '@anthropic-ai/sandbox-runtime'
export const sandboxPatch = Object.freeze({
  version: '0.0.77',
  integrity: 'sha512-uOe6kkAbo91r5shXXBxZ1DKbOpWmnXkNDDujXrFJRaHSG7D7s8b7Yfsu0pGDkYFgKZ2ECtVCNisl6pCYcaMF7A==',
  patchSha256: 'fc6426d1dbfbd24768ad36c9ffdd92814aa6d2c16812fd3f28f6ac93b211e39c',
  file: 'dist/sandbox/linux-sandbox-utils.js',
  originalSha256: '2e407538b632396abcd9410c5286d6aef7207e43535cf479bd6489adf56bcb3e',
  patchedSha256: 'a2efc2877b060a06b61ae27b36ccb6b6ed0a6bc6f069311e3f8879430a998644',
})
const sandboxVersions = Object.freeze({ [sandboxPackage]: '0.0.77', '@pondwader/socks5-server': '1.0.10', commander: '12.1.0', 'node-forge': '1.4.0', zod: '3.25.76' })
const provenanceName = 'dist/PULSE-PROVENANCE.json'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const within = (root, path) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) }
const excluded = name => name.startsWith('._') || ['node_modules', '.bin', '.pnpm', '.git', '.DS_Store', '.npmrc', '.package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].includes(name)
const manifest = async path => JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
const packageName = name => assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i, 'Invalid dependency name')

export async function resolveInstalledPackage(name, owner) {
  packageName(name)
  for (let directory = owner; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    try {
      const physical = await realpath(candidate)
      assert.equal((await manifest(physical)).name, name, 'Dependency identity mismatch')
      return physical
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(directory) === directory) break
  }
  // Export maps may hide package.json; locate the package containing its entry.
  const entry = createRequire(join(owner, 'package.json')).resolve(name)
  for (let directory = dirname(entry); dirname(directory) !== directory; directory = dirname(directory)) {
    if (await manifest(directory).then(value => value.name === name, error => { if (error.code === 'ENOENT') return false; throw error })) return realpath(directory)
  }
  throw new Error(`DEPENDENCY_NOT_FOUND:${name}`)
}

/** Copy payload only. Local package-manager shims and dependency links never
 * enter an artifact; declared dependencies are rebuilt separately below. */
export async function copyPackagePayload(source, target) {
  source = await realpath(source)
  const active = new Set()
  async function visit(from, to) {
    const physical = await realpath(from)
    assert.ok(within(source, physical), 'DEPENDENCY_LINK_ESCAPE')
    assert.ok(!active.has(physical), 'DEPENDENCY_LINK_CYCLE')
    const info = await lstat(physical)
    if (info.isDirectory()) {
      active.add(physical)
      await mkdir(to, { recursive: true })
      for (const entry of await readdir(physical)) if (!excluded(entry)) await visit(join(physical, entry), join(to, entry))
      active.delete(physical)
    } else {
      assert.ok(info.isFile(), 'DEPENDENCY_SPECIAL_FILE')
      await copyFile(physical, to)
      await chmod(to, info.mode & 0o777)
    }
  }
  await visit(source, target)
}

export async function copyProductionDependency(name, source, target, options = {}) {
  const { skip = () => false, ancestors = [] } = options
  packageName(name)
  source = await realpath(source)
  assert.ok(!ancestors.includes(source), 'DEPENDENCY_CYCLE')
  const data = await manifest(source)
  assert.equal(data.name, name, 'Dependency identity mismatch')
  await copyPackagePayload(source, target)
  for (const dependency of Object.keys({ ...data.dependencies, ...data.optionalDependencies })) {
    if (skip(dependency)) continue
    let location
    try { location = await resolveInstalledPackage(dependency, source) }
    catch (error) {
      if (dependency in (data.optionalDependencies ?? {}) && ['MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) continue
      throw error
    }
    await copyProductionDependency(dependency, location, join(target, 'node_modules', dependency), { skip, ancestors: [...ancestors, source] })
  }
  if (name === sandboxPackage) await sealSandboxBundle(target)
}

async function payloadFiles(directory) {
  const files = {}
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      if (name === 'node_modules' || relative(directory, join(path, name)).split(sep).join('/') === provenanceName) continue
      assert.ok(!excluded(name), 'PACKAGE_MANAGER_METADATA_IN_BUNDLE')
      const file = join(path, name), info = await lstat(file)
      assert.ok(!info.isSymbolicLink(), 'SYMLINK_IN_BUNDLE')
      if (info.isDirectory()) await visit(file)
      else { assert.ok(info.isFile(), 'SPECIAL_FILE_IN_BUNDLE'); files[relative(directory, file).split(sep).join('/')] = hash(await readFile(file)) }
    }
  }
  await visit(directory)
  return files
}

async function sandboxClosure(root) {
  root = await realpath(root)
  const found = new Map()
  async function visit(path) {
    const data = await manifest(path)
    assert.equal(data.version, sandboxVersions[data.name], `Unexpected SDK closure: ${data.name}`)
    if (found.has(data.name)) { assert.equal(found.get(data.name).path, path, 'Duplicate SDK dependency'); return }
    found.set(data.name, { path, data })
    for (const name of Object.keys({ ...data.dependencies, ...data.optionalDependencies })) {
      const dependency = await resolveInstalledPackage(name, path)
      // Standalone SDK bundles must not accidentally resolve through the repo.
      assert.ok(within(root, dependency), `SDK_DEPENDENCY_OUTSIDE_BUNDLE:${name}`)
      await visit(dependency)
    }
  }
  await visit(root)
  assert.deepEqual([...found.keys()].sort(), Object.keys(sandboxVersions).sort(), 'Incomplete SDK closure')
  return found
}

export async function sealSandboxBundle(root) {
  assert.equal(hash(await readFile(join(root, sandboxPatch.file))), sandboxPatch.patchedSha256, 'SANDBOX_PATCH_MISSING')
  await writeFile(join(root, 'dist/PULSE-MODIFICATIONS.txt'), 'Pulse modification to @anthropic-ai/sandbox-runtime 0.0.77: restore authorized writable child mounts after read-only ancestor mounts on Linux. No grants are added; subsequent read/write denies remain in force. Upstream license and notices are retained. See PULSE-PROVENANCE.json for upstream integrity and patch hashes.\n')
  const packages = []
  for (const { path, data } of (await sandboxClosure(root)).values()) {
    const files = await payloadFiles(path)
    assert.ok(Object.keys(files).some(name => /(?:^|\/)(?:licen[cs]e|copying)(?:[.-]|$)/i.test(name)), `DEPENDENCY_LICENSE_MISSING:${data.name}`)
    packages.push({ name: data.name, version: data.version, files })
  }
  await writeFile(join(root, provenanceName), JSON.stringify({ schemaVersion: 1, upstream: sandboxPatch, packages }, null, 2) + '\n')
  await verifySandboxBundle(root)
}

/** Optimized desktop bundles may remove only source maps and foreign native
 * payloads, and may deduplicate dependencies within their sealed app root. */
export async function verifySandboxBundle(root, { bundleRoot = root, platform, arch } = {}) {
  root = await realpath(root); bundleRoot = await realpath(bundleRoot)
  assert.ok(within(bundleRoot, root), 'SDK_OUTSIDE_BUNDLE')
  const provenance = JSON.parse(await readFile(join(root, provenanceName), 'utf8'))
  assert.equal(provenance.schemaVersion, 1)
  assert.deepEqual(provenance.upstream, sandboxPatch, 'SDK_PROVENANCE_MISMATCH')
  assert.equal(hash(await readFile(join(root, sandboxPatch.file))), sandboxPatch.patchedSha256, 'SANDBOX_PATCH_MISSING')
  assert.deepEqual(provenance.packages.map(p => [p.name, p.version]).sort(), Object.entries(sandboxVersions).sort())
  for (const saved of provenance.packages) {
    const path = saved.name === sandboxPackage ? root : await resolveInstalledPackage(saved.name, root)
    assert.ok(within(bundleRoot, path), `SDK_DEPENDENCY_OUTSIDE_BUNDLE:${saved.name}`)
    assert.equal((await manifest(path)).version, saved.version)
    const actual = await payloadFiles(path)
    const removable = name => platform && (/\.(?:[cm]?js|d\.ts)\.map$/.test(name) || saved.name === sandboxPackage && (
      name.startsWith('vendor/seccomp/') && (platform !== 'linux' || !name.startsWith(`vendor/seccomp/${arch}/`)) ||
      name.startsWith('vendor/srt-win/') && (platform !== 'win32' || !name.startsWith(`vendor/srt-win/${arch}/`))))
    for (const [name, digest] of Object.entries(saved.files)) {
      if (!(name in actual) && removable(name)) continue
      assert.equal(actual[name], digest, `SDK_PAYLOAD_CHANGED:${saved.name}/${name}`)
    }
    assert.ok(Object.keys(actual).every(name => name in saved.files), 'UNRECORDED_SDK_PAYLOAD')
  }
  if (!platform || platform === 'linux') {
    for (const target of platform ? [arch] : ['arm64', 'x64']) {
      const info = await lstat(join(root, 'vendor/seccomp', target, 'apply-seccomp'))
      if (process.platform !== 'win32') assert.ok(info.mode & 0o111, 'SECCOMP_NOT_EXECUTABLE')
    }
  }
  return { version: sandboxPatch.version, patchedSha256: sandboxPatch.patchedSha256, packages: provenance.packages.length }
}

/** Archive ownership is distribution metadata, never the build user's identity.
 * GNU and libarchive tar use different owner/metadata switches. Keep their
 * native long-path support and preserve every payload byte and executable mode.
 */
export function portableTarArguments(version, archive, stage) {
  if (/\bbsdtar\b/.test(version) && /libarchive/.test(version)) {
    return ['--uid=0', '--gid=0', '--uname=root', '--gname=root', '--no-xattrs', '--no-acls', '--no-fflags', '-czf', archive, '-C', stage, 'pulse']
  }
  if (/\(GNU tar\)/.test(version)) {
    return ['--format=posix', '--owner=0', '--group=0', '--numeric-owner', '--no-xattrs', '--no-acls', '--pax-option=delete=atime,delete=ctime', '-czf', archive, '-C', stage, 'pulse']
  }
  throw new Error('UNSUPPORTED_TAR_METADATA_FORMAT')
}

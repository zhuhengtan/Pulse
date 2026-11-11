/** Offline synthetic fixtures only. Never starts Pulse or accesses user data. */
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone runtime script has no declaration file.
import { createSnapshot, verifySnapshot, snapshotRuntimeDigest, parseArgs, TOOL_FILE, MANIFEST_DIR, MANIFEST_NAME, EXIT } from '../scripts/self-host-snapshot.mjs'

let tmp: string
let created: any
let manifest: any
const clone = (value: any) => JSON.parse(JSON.stringify(value))
const manifestPath = (root: string) => path.join(root, MANIFEST_DIR, MANIFEST_NAME)
const kinds = (result: any) => result.violations.map((v: any) => v.kind)
async function variant(tag: string, edit: (m: any, root: string) => unknown) {
  const root = path.join(tmp, tag)
  // fs.cp does not preserve the Windows directory-link type. Its inferred type
  // can become 'file' if a relative target has not been copied yet. Copy the
  // physical entries first, then preserve the source links as directory links,
  // matching createSnapshot rather than depending on directory iteration order.
  const links: Array<{ source: string; destination: string }> = []
  await fs.cp(created.snapshot, root, {
    recursive: true,
    filter: async (source, destination) => {
      if (!(await fs.lstat(source)).isSymbolicLink()) return true
      links.push({ source, destination })
      return false
    },
  })
  for (const { source, destination } of links) {
    expect((await fs.stat(source)).isDirectory()).toBe(true)
    await fs.symlink(await fs.readlink(source), destination, 'dir')
  }
  const m = clone(manifest)
  await edit(m, root)
  await fs.writeFile(manifestPath(root), JSON.stringify(m))
  return root
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-snapshot-identity-'))
  const cwd = path.join(tmp, 'source')
  const app = path.join(cwd, 'node_modules', 'identity-app')
  const dep = path.join(cwd, 'node_modules', 'identity-dep')
  await fs.mkdir(app, { recursive: true })
  await fs.mkdir(dep, { recursive: true })
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'identity-app', version: '1.0.0', dependencies: { 'identity-dep': '1.0.0' }, optionalDependencies: { missing: '*' } }))
  await fs.writeFile(path.join(app, 'cli.js'), "console.log(require('identity-dep'))\n")
  await fs.writeFile(path.join(dep, 'package.json'), JSON.stringify({ name: 'identity-dep', version: '1.0.0', main: 'index.js' }))
  await fs.writeFile(path.join(dep, 'index.js'), 'module.exports = 1\n')
  created = await createSnapshot({ cwd, cliEntry: path.join(app, 'cli.js'), snapshot: path.join(tmp, 'snapshot') })
  manifest = JSON.parse(await fs.readFile(created.manifest, 'utf8'))
})
afterAll(async () => { if (tmp) await fs.rm(tmp, { recursive: true, force: true }) })

describe('snapshot runtime identity', () => {
  it('preserves a relocated clone with relative directory links and the original identity', async () => {
    const root = await variant('unchanged', () => {})
    const result = await verifySnapshot({ snapshot: root, expectedDigest: created.runtimeDigest })
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.runtimeDigest).toBe(created.runtimeDigest)
    expect(manifest.links.length).toBeGreaterThan(0)
    for (const link of manifest.links) {
      const copied = path.join(root, link.path)
      const target = await fs.readlink(copied)
      expect(path.isAbsolute(target)).toBe(false)
      expect(target.replaceAll('\\', '/')).toBe(link.target)
      expect((await fs.stat(copied)).isDirectory()).toBe(true)
      expect(await fs.realpath(copied)).toBe(await fs.realpath(path.resolve(path.dirname(copied), link.target)))
      expect(await fs.realpath(copied)).not.toBe(await fs.realpath(path.join(created.snapshot, link.path)))
    }
  })

  it('includes the isolated runtime controller and binds its bytes into the capsule digest', async () => {
    expect(manifest.entries.runtimeController).toBe('code/supervisor/self-host-runtime.mjs')
    expect(manifest.files.some((file: any) => file.path === manifest.entries.runtimeController)).toBe(true)
    const root = await variant('changed-runtime-controller', async (m, root) => {
      await fs.appendFile(path.join(root, m.entries.runtimeController), '\n// changed controller\n')
    })
    expect((await verifySnapshot({ snapshot: root, expectedDigest: created.runtimeDigest })).ok).toBe(false)
  })

  it('creates and returns a SHA256 identity, independent of record/key ordering', async () => {
    expect(created.runtimeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.runtimeIdentity).toEqual({ schema: 1, algorithm: 'sha256', digest: created.runtimeDigest })
    const reordered = clone(manifest)
    for (const field of ['nodes', 'edges', 'files', 'links']) reordered[field].reverse()
    for (const node of reordered.nodes) node.dependencies.reverse()
    const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reverseKeys(value[k])])) : value
    expect(snapshotRuntimeDigest(reverseKeys(reordered))).toBe(created.runtimeDigest)
    expect((await verifySnapshot({ snapshot: created.snapshot, expectedDigest: created.runtimeDigest })).runtimeDigest).toBe(created.runtimeDigest)
  })

  it('ignores creation/source metadata and identity itself', () => {
    const changed = clone(manifest)
    changed.createdAt = '2099-01-01T00:00:00Z'
    changed.source = { cwd: '/not/read', cliEntry: '/not/read/cli.js' }
    changed.generator = { file: 'different-metadata' }
    changed.runtimeIdentity.digest = '0'.repeat(64)
    expect(snapshotRuntimeDigest(changed)).toBe(created.runtimeDigest)
  })

  it.each(['entries', 'files', 'links', 'nodes', 'edges', 'layout', 'dataPolicy'])('binds runtime %s', (field) => {
    const changed = clone(manifest)
    if (Array.isArray(changed[field])) changed[field][0].identityTest = 'changed'
    else changed[field].identityTest = 'changed'
    expect(snapshotRuntimeDigest(changed)).not.toBe(created.runtimeDigest)
  })

  it('binds file contents, permissions and dependency resolutions', () => {
    for (const edit of [
      (m: any) => { m.files[0].sha256 = '0'.repeat(64) },
      (m: any) => { m.files[0].mode ^= 0o100 },
      (m: any) => { m.nodes.find((n: any) => n.dependencies.length).dependencies[0].resolved = null },
    ]) {
      const changed = clone(manifest)
      edit(changed)
      expect(snapshotRuntimeDigest(changed)).not.toBe(created.runtimeDigest)
    }
  })

  it('rejects rewritten code and a rewritten self-consistent manifest against an external anchor', async () => {
    const root = await variant('rewrite', async (m, dir) => {
      const record = m.files.find((f: any) => f.path === m.entries.cli)
      const body = "console.log('rewritten')\n"
      await fs.writeFile(path.join(dir, record.path), body)
      record.size = Buffer.byteLength(body)
      record.sha256 = crypto.createHash('sha256').update(body).digest('hex')
      m.runtimeIdentity.digest = snapshotRuntimeDigest(m)
    })
    const unbound = await verifySnapshot({ snapshot: root })
    expect(unbound.violations).toEqual([])
    expect(unbound.ok).toBe(true)
    expect(unbound.runtimeDigest).not.toBe(created.runtimeDigest)
    const bound = await verifySnapshot({ snapshot: root, expectedDigest: created.runtimeDigest })
    expect(bound.ok).toBe(false)
    expect(kinds(bound)).toEqual(['expected-digest-mismatch'])
  })

  it.each([null, [], {}, { schema: 2, algorithm: 'sha256', digest: '0'.repeat(64) }, { schema: 1, algorithm: 'md5', digest: '0'.repeat(64) }, { schema: 1, algorithm: 'sha256', digest: 'bad' }])('rejects malformed identity %j', async (identity) => {
    const root = await variant(`malformed-${crypto.randomUUID()}`, m => { m.runtimeIdentity = identity })
    expect(kinds(await verifySnapshot({ snapshot: root }))).toContain('runtime-identity-invalid')
  })

  it('rejects a well-formed but mismatched identity', async () => {
    const root = await variant('mismatch', m => { m.runtimeIdentity.digest = '0'.repeat(64) })
    expect(kinds(await verifySnapshot({ snapshot: root }))).toContain('runtime-identity-mismatch')
  })

  it.each(['files', 'links', 'nodes', 'edges', 'dependencies'])('never masks duplicate %s records, even with a fresh digest', async (field) => {
    const root = await variant(`duplicate-${field}`, m => {
      const records = field === 'dependencies' ? m.nodes.find((n: any) => n.dependencies.length).dependencies : m[field]
      records.push(clone(records[0]))
      expect(snapshotRuntimeDigest(m)).not.toBe(created.runtimeDigest)
      m.runtimeIdentity.digest = snapshotRuntimeDigest(m)
    })
    expect(kinds(await verifySnapshot({ snapshot: root }))).toContain('duplicate-record')
  })

  it('verifies legacy v1 without identity and still enforces external anchors', async () => {
    const root = await variant('legacy', m => { delete m.runtimeIdentity })
    const result = await verifySnapshot({ snapshot: root, expectedDigest: created.runtimeDigest })
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.runtimeDigest).toBe(created.runtimeDigest)
    expect(kinds(await verifySnapshot({ snapshot: root, expectedDigest: '0'.repeat(64) }))).toContain('expected-digest-mismatch')
  })

  it.each(['', 'bad', 'A'.repeat(64), null, 123])('rejects malformed external anchor %j', async (expectedDigest) => {
    expect(kinds(await verifySnapshot({ snapshot: created.snapshot, expectedDigest }))).toContain('expected-digest-invalid')
  })

  it('propagates external anchors through CLI verification and generated supervisor invocation', () => {
    expect(parseArgs(['verify', '--expected-digest=' + created.runtimeDigest]).expectedDigest).toBe(created.runtimeDigest)
    for (const [digest, status] of [[created.runtimeDigest, EXIT.ok], ['0'.repeat(64), EXIT.verify]]) {
      const run = spawnSync(process.execPath, [TOOL_FILE, 'verify', '--snapshot', created.snapshot, '--expected-digest', digest, '--json'], { encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(status)
      expect(JSON.parse(run.stdout).runtimeDigest).toBe(created.runtimeDigest)
    }
    const argv = created.invoke.argv
    expect(argv[argv.indexOf('--engine-snapshot') + 1]).toBe(created.snapshot)
    expect(argv[argv.indexOf('--engine-digest') + 1]).toBe(created.runtimeDigest)
  })
})

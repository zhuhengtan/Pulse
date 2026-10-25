import { afterEach, describe, expect, it } from 'vitest'
import { readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { UpdateManager } from '../packages/server/src/updates/manager.js'
import { componentSchema, compatible, protocols, releaseId } from '../packages/server/src/updates/contracts.js'
import { signedValue, inside } from '../packages/server/src/updates/security.js'
import { atomicJson, initialState, readState, statePath, withUpdateLock } from '../packages/server/src/updates/store.js'
import { frontendResource } from '../packages/server/src/updates/frontend.js'
import { updateFixture } from './update-fixtures.js'
import { installManagedLauncher, migrateManagedServices } from '../packages/server/src/updates/bootstrap.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work() })
async function setup() {
  const f = await updateFixture(); cleanup.push(async () => { await f.close(); await rm(f.root, { recursive: true, force: true }) })
  const manager = new UpdateManager({ root: f.root, dataDir: f.dataDir, backendVersion: '0.8.0', development: true, indexUrl: f.base + 'index.json', keys: f.keys })
  return { ...f, manager }
}
describe('signed independent updates', () => {
  it('reports actual backend module metadata and the bundled frontend version', async () => {
    const f = await setup(), directory = join(f.root, 'bundled-web')
    await mkdir(directory); await writeFile(join(directory, 'version.json'), JSON.stringify({ version: '0.8.1' }))
    f.manager.options.frontendDirectory = directory
    const status = await f.manager.status()
    expect(status.frontendVersion).toBe('0.8.1')
    expect(status.modules?.map(module => module.title)).toEqual(['Server', 'CLI', 'Runtime', 'Data', 'Adapters', 'Tool SDK'])
    for (const module of status.modules ?? []) expect(module.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(status.environment?.node).toBe(process.versions.node)
    const paired = await f.manager.status(false)
    expect(paired).not.toHaveProperty('modules')
    expect(paired).not.toHaveProperty('environment')
  })
  it('rejects forged signatures, unknown keys and escaping paths', async () => {
    const f = await setup(), manifest = await f.add()
    const envelope = f.signed(manifest)
    expect(signedValue(envelope, componentSchema, f.keys).value.version).toBe('0.9.0')
    expect(() => signedValue({ ...envelope, payload: envelope.payload.replace('0.9.0', '9.9.9') }, componentSchema, f.keys)).toThrow('UPDATE_SIGNATURE_INVALID')
    expect(() => signedValue({ ...envelope, keyId: 'unknown' }, componentSchema, f.keys)).toThrow('UPDATE_SIGNATURE_INVALID')
    for (const value of ['../outside', '/absolute', 'C:\\outside', 'a\\b', 'a/../../escape']) expect(() => inside(f.root, value)).toThrow('UPDATE_PATH_INVALID')
  })
  it('downloads and activates a frontend without replacing the backend; retains old lazy assets', async () => {
    const f = await setup(), first = await f.add(); f.index()
    await f.manager.check(); await f.manager.download(); await f.manager.requestApply()
    expect(await f.manager.applyFrontend()).toBe(true)
    const html = await frontendResource(f.manager, undefined, '/chat', true)
    expect(html?.content.toString()).toContain(`/_pulse/${releaseId(first)}/`)
    expect(html?.content.toString()).toContain('name="pulse-frontend-version" content="0.9.0"')
    const second = await f.add('0.10.0'); f.index(2)
    await f.manager.check(); await f.manager.download(); await f.manager.requestApply(); await f.manager.applyFrontend()
    expect((await f.manager.status()).frontendVersion).toBe(second.version)
    const old = await frontendResource(f.manager, undefined, `/_pulse/${releaseId(first)}/assets/main.js`, false)
    expect(old?.content.toString()).toContain('version = 1')
    await f.manager.requestApply(true); await f.manager.applyFrontend()
    expect((await f.manager.status()).frontendVersion).toBe(first.version)
    expect((await readState(f.root, f.dataDir)).active.backend).toBeUndefined()
    expect(f.manager.select(await readState(f.root, f.dataDir))).toEqual([])
  })
  it('keeps the working frontend on interrupted or corrupted downloads and retries only explicitly', async () => {
    const f = await setup(), manifest = await f.add(); f.index()
    await f.manager.check(); f.content.set('/frontend-0.9.0.zip', Buffer.from('truncated'))
    await f.manager.download()
    const state = await readState(f.root, f.dataDir)
    expect(state.error).toBe('UPDATE_DIGEST_INVALID'); expect(state.active).toEqual({}); expect(state.staged).toBeUndefined()
    expect(await readdir(join(f.root, 'updates/staging'))).toEqual([])
  })
  it('rejects expired or rolled back indexes without replacing previously verified metadata', async () => {
    const f = await setup(); await f.add(); f.index(10); await f.manager.check()
    f.index(9); await f.manager.check(); expect((await readState(f.root, f.dataDir)).error).toBe('UPDATE_INDEX_STALE')
    f.index(11, new Date(Date.now() - 1000).toISOString()); await f.manager.check()
    expect((await readState(f.root, f.dataDir)).sequence).toBe(10)
  })
  it('chooses a compatible pair and preserves an old shell capability across server restarts', async () => {
    const f = await setup()
    await f.manager.registerShell('0.8.0', 130)
    await f.add('1.1.0', 'backend', {}, { requires: { ...protocols, http: 2 } })
    const tooNew = await f.add('1.0.0', 'backend', {}, { requires: { ...protocols, shell: '1.0.0' } })
    const validBackend = await f.add('0.9.0', 'backend', {})
    await f.add('1.0.0', 'frontend', undefined, { requires: { ...protocols, backend: '1.0.0' } })
    const validFrontend = await f.add('0.9.0', 'frontend', undefined, { requires: { ...protocols, backend: '0.9.0' } })
    f.index(); await f.manager.check()
    const restarted = new UpdateManager({ root: f.root, dataDir: f.dataDir, backendVersion: '0.8.0' })
    expect(restarted.select(await readState(f.root, f.dataDir)).map(item => `${item.component}:${item.version}`)).toEqual(['backend:0.9.0', 'frontend:0.9.0'])
    expect(compatible({ ...validBackend, data: { min: 1, max: 2, writes: 2, reversible: false } }, { backend: '0.8.0', data: 1 })).toContain('MANUAL_DATA_MIGRATION_REQUIRED')
  })
  it('blocks shell and chromium requirements until those versions are known', async () => {
    const f = await setup()
    const shellBound = await f.add('0.9.0', 'backend', {}, { requires: { ...protocols, shell: '0.8.0' } })
    const browserBound = await f.add('0.9.1', 'backend', {}, { requires: { ...protocols, chromium: 120 } })
    expect(compatible(shellBound, { backend: '0.8.0', data: 1 })).toContain('SHELL_REQUIRED')
    expect(compatible(browserBound, { backend: '0.8.0', data: 1 })).toContain('CHROMIUM_REQUIRED')
    expect(compatible(shellBound, { backend: '0.8.0', shell: '0.8.0', data: 1 })).not.toContain('SHELL_REQUIRED')
    expect(compatible(browserBound, { backend: '0.8.0', chromium: 120, data: 1 })).not.toContain('CHROMIUM_REQUIRED')
    f.index(); await f.manager.check()
    expect(f.manager.select(await readState(f.root, f.dataDir))).toEqual([])
  })
  it('refuses a changed frontend asset and falls back to the bundled page', async () => {
    const f = await setup(), manifest = await f.add(); f.index()
    const bundled = join(f.root, 'bundled-web')
    await mkdir(bundled); await writeFile(join(bundled, 'index.html'), '<head></head><p>bundled</p>'); await writeFile(join(bundled, 'version.json'), JSON.stringify({ version: '0.8.0' }))
    await f.manager.check(); await f.manager.download(); await f.manager.requestApply(); await f.manager.applyFrontend()
    const selected = await f.manager.frontend()
    await writeFile(join(selected!.directory, 'assets/main.js'), 'tampered')
    await expect(frontendResource(f.manager, bundled, `/_pulse/${releaseId(manifest)}/assets/main.js`, false)).resolves.toBeUndefined()
    const page = await frontendResource(f.manager, bundled, '/chat', true)
    expect(page?.content.toString()).toContain('bundled')
    expect(page?.content.toString()).toContain('name="pulse-frontend-version" content="0.8.0"')
  })
  it('serializes concurrent processes and leaves live-owner locks intact', async () => {
    const f = await setup(), order: number[] = []
    await Promise.all([withUpdateLock(f.root, async () => { order.push(1); await new Promise(resolve => setTimeout(resolve, 130)); order.push(2) }), withUpdateLock(f.root, async () => { order.push(3) })])
    expect(order).toHaveLength(3); expect(order.indexOf(2)).toBe(order.indexOf(1) + 1)
    expect(await readFile(join(f.root, 'updates/update.lock')).catch(() => undefined)).toBeUndefined()
  })
  it('only exposes the frontend generation to paired non-admin devices', async () => {
    const f = await setup(); await f.add(); f.index(); await f.manager.check()
    expect(await f.manager.status(false)).toEqual({ frontend: 'bundled', frontendVersion: undefined, protocols: { http: 1, events: 1 } })
  })
  it('preserves the active release on filesystem failure and rejects escaping archive links', async () => {
    const f = await setup(); await f.add('0.9.0', 'frontend', { redirect: '../outside' }, { files: { redirect: { link: '../outside' } } }); f.index()
    await f.manager.check(); await f.manager.download()
    expect((await readState(f.root, f.dataDir)).error).toBe('UPDATE_PATH_INVALID')
    await f.add('0.10.0'); f.index(2); await f.manager.check()
    await writeFile(join(f.root, 'updates/components'), 'a file occupies the component directory')
    await f.manager.download()
    expect((await readState(f.root, f.dataDir)).phase).toBe('failed')
    expect((await readState(f.root, f.dataDir)).active).toEqual({})
  })
  it('keeps a stable bootstrap until it is damaged, preserves user commands, and migrates service definitions without restarting', async () => {
    const f = await setup(), first = join(f.root, 'first'), second = join(f.root, 'second')
    for (const directory of [first, second]) {
      await mkdir(join(directory, 'app/node_modules/@hunterzhu/pulse-server/dist/updates'), { recursive: true })
      await writeFile(join(directory, 'app/node_modules/@hunterzhu/pulse-server/dist/updates/launcher.js'), '')
      await writeFile(join(directory, 'critical'), 'healthy')
      await atomicJson(join(directory, 'desktop-runtime.json'), { critical: ['critical'], files: { critical: { sha256: (await import('./update-fixtures.js')).hash('healthy') } } })
    }
    await mkdir(join(f.root, 'bin')); await writeFile(join(f.root, 'bin', process.platform === 'win32' ? 'pulse.cmd' : 'pulse'), 'user-owned command')
    const launcher = await installManagedLauncher(f.root, first, f.dataDir)
    expect(launcher).toContain('pulse-desktop')
    await installManagedLauncher(f.root, second, f.dataDir)
    expect(JSON.parse(await readFile(join(f.root, 'updates/bootstrap.json'), 'utf8')).directory).toBe(first)
    await rm(join(first, 'critical')); await installManagedLauncher(f.root, second, f.dataDir)
    expect(JSON.parse(await readFile(join(f.root, 'updates/bootstrap.json'), 'utf8')).directory).toBe(second)
    const home = join(f.root, 'user'), definition = join(home, 'Library/LaunchAgents/com.hunterzhu.pulse.h5.plist')
    await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true }); await writeFile(definition, '<key>Label</key><string>com.hunterzhu.pulse.h5</string><key>ProgramArguments</key><array><string>/old/node</string><string>/old/bin.js</string><string>h5</string><string>daemon</string><string>--port</string><string>7444</string></array>')
    expect(await migrateManagedServices(f.root, second, home)).toContain(definition)
    expect(await readFile(definition, 'utf8')).toContain('7444')
    expect(await readFile(definition, 'utf8')).not.toContain('/old/bin.js')
  })
})

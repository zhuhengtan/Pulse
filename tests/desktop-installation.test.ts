import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DesktopInstallation, launcherText, registerLauncher, registerPath } from '../packages/desktop/src/installation.mjs'
import { runtimeFile, verifyRuntime, writeRuntimeManifest } from '../packages/desktop/src/runtime-manifest.mjs'
const exec = promisify(execFile)

it('fully checks later noncritical files and detects same-size corruption before cleanup', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-runtime-integrity-'))
 try {
  const files: Record<string, { bytes: number; sha256: string }> = {}
  for (let i = 0; i < 24; i++) {
   const text = `component-${String(i).padStart(2, '0')}`
   await writeFile(join(root, `${i}.js`), text)
   files[`${i}.js`] = { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }
  }
  const manifest = { files, critical: ['0.js'] }
  await expect(verifyRuntime(root, manifest, true)).resolves.toBeUndefined()
  await writeFile(join(root, '23.js'), 'component-XX')
  await expect(verifyRuntime(root, manifest)).resolves.toBeUndefined()
  await expect(verifyRuntime(root, manifest, true)).rejects.toThrow('RUNTIME_FILE_CHANGED:23.js')
  // Verification must have released its reads before a failed installation is removed.
  await rm(root, { recursive: true })
 } finally { await rm(root, { recursive: true, force: true }) }
})
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "pulse-install space's-")), source = join(root, 'bundle'), install = join(root, 'home/.pulse'), shellHome = join(root, 'home')
 const files = {
  'node': `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
  'app/node_modules/@hunterzhu/pulse-cli/package.json': '{"type":"module","version":"0.7.0"}',
  'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js': "console.log(JSON.stringify(process.argv.includes('--show-environment')?{config:process.env.PULSE_CONFIG,data:process.env.PULSE_DATA_DIR}:process.argv.slice(2)))",
  'app/node_modules/@hunterzhu/pulse-cli/dist/config.js': "import{mkdir,writeFile}from'node:fs/promises';import{dirname}from'node:path';export async function ensurePulseUserConfig(p){await mkdir(dirname(p),{recursive:true});await writeFile(p,'{\"activeModel\":\"mock\"}',{flag:'wx',mode:384}).catch(e=>{if(e.code!=='EEXIST')throw e})}",
  'app/node_modules/@hunterzhu/pulse-server/dist/index.js': '// bundled server',
  'app/node_modules/@hunterzhu/pulse-server/dist/web/index.html': '<html>Bundled UI</html>',
 }
 for (const [name, text] of Object.entries(files)) { const path = join(source, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text, { mode: name === 'node' ? 0o755 : 0o644 }) }
 await writeRuntimeManifest(source, '0.7.0')
 const options = { root: install, userData: join(root, 'profile'), source, shellHome, dataDirectory: join(root, 'shared-data'), env: { PATH: '/nonexistent', SHELL: '/bin/zsh' }, packaged: true }
 return { root, source, install, shellHome, options }
}
it.runIf(process.platform !== 'win32')('installs once, runs without Node on PATH, preserves config and shares an immutable runtime', async () => {
 const f = await fixture()
 try {
  const setup = new DesktopInstallation(f.options)
  await Promise.all([setup.prepare(), setup.prepare()])
  expect(setup.snapshot().phase).toBe('starting')
  expect(setup.snapshot().firstRun).toBe(true)
  expect(setup.snapshot().steps.every(s => s.state === 'ready')).toBe(true)
  const args = ['--version', 'an argument with spaces', '$(touch /tmp/unwanted-install-test)']
  const result = await exec(setup.state.cli.path, args, { env: { PATH: '/nonexistent' } })
  expect(JSON.parse(result.stdout)).toEqual(args)
  const shared = await exec(setup.state.cli.path, ['--show-environment'], { env: { PATH: '/nonexistent' } })
  expect(JSON.parse(shared.stdout)).toEqual({ config: setup.state.configPath, data: f.options.dataDirectory })
  const original = await readFile(setup.state.configPath, 'utf8')
  setup.state.phase = 'ready'; await setup.complete()
  const again = new DesktopInstallation(f.options); await again.prepare()
  expect(again.state.firstRun).toBe(false)
  expect(again.state.runtimeDirectory).toBe(setup.state.runtimeDirectory)
  expect(await readdir(join(f.install, 'desktop/runtimes'))).toHaveLength(1)
  expect(await readFile(again.state.configPath, 'utf8')).toBe(original)
  const profile = await readFile(join(f.shellHome, '.zprofile'), 'utf8')
  expect(profile.match(/>>> Pulse Desktop CLI/g)).toHaveLength(1)
  const fromShell = await exec('/bin/sh', ['-c', '. "$1"; command -v pulse; pulse --version', 'fixture', join(f.shellHome, '.zprofile')], { env: { PATH: '/nonexistent' } })
  expect(fromShell.stdout).toContain(setup.state.cli.path)
 } finally { await rm(f.root, { recursive: true, force: true }) }
})
it.runIf(process.platform !== 'win32')('preserves independent CLI commands and user settings', async () => {
 const f = await fixture()
 try {
  await mkdir(join(f.install, 'bin'), { recursive: true }); await writeFile(join(f.install, 'bin/pulse'), '#!/bin/sh\n# independently installed\n', { mode: 0o755 })
  await writeFile(join(f.install, 'config.json'), '{"my":"settings"}')
  const setup = new DesktopInstallation(f.options); await setup.prepare()
  expect(setup.state.cli.conflict).toBe(join(f.install, 'bin/pulse'))
  expect(await readFile(join(f.install, 'bin/pulse'), 'utf8')).toContain('independently installed')
  expect(await readFile(join(f.install, 'config.json'), 'utf8')).toBe('{"my":"settings"}')
 } finally { await rm(f.root, { recursive: true, force: true }) }
})
it.runIf(process.platform !== 'win32')('repairs missing components into a new directory without overwriting a live version', async () => {
 const f = await fixture()
 try {
  const setup = new DesktopInstallation(f.options); await setup.prepare()
  const old = setup.state.runtimeDirectory, removed = 'app/node_modules/@hunterzhu/pulse-server/dist/index.js'
  await rm(join(old, removed))
  await setup.prepare({ full: true })
  expect(setup.state.runtimeDirectory).not.toBe(old)
  expect(await readFile(join(setup.state.runtimeDirectory, removed), 'utf8')).toContain('bundled server')
  expect(await readFile(join(f.install, 'bin/pulse'), 'utf8')).toContain(basename(setup.state.runtimeDirectory))
 } finally { await rm(f.root, { recursive: true, force: true }) }
})
it.runIf(process.platform !== 'win32')('fails before installation on corrupted bundles and rejects traversal', async () => {
 const f = await fixture()
 try {
  await writeFile(join(f.source, 'app/node_modules/@hunterzhu/pulse-server/dist/index.js'), 'corrupt')
  const setup = new DesktopInstallation(f.options)
  await expect(setup.prepare()).rejects.toThrow()
  expect(setup.state.phase).toBe('error')
  expect(() => runtimeFile(f.root, '../outside')).toThrow('INVALID_RUNTIME_MANIFEST')
 } finally { await rm(f.root, { recursive: true, force: true }) }
})
it.runIf(process.platform !== 'win32')('does not modify symlink-managed shell configuration or overwrite a symlink CLI entry', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-shell-path-'))
 try {
  const original = join(root, 'original'); await writeFile(original, '# my shell config\n'); await symlink(original, join(root, '.zprofile'))
  await expect(registerPath(join(root, 'bin'), root, {}, 'darwin')).rejects.toThrow('SHELL_PROFILE_SYMLINK')
  expect(await readFile(original, 'utf8')).toBe('# my shell config\n')
  await mkdir(join(root, 'bin')); await symlink(original, join(root, 'bin/pulse'))
  expect(await registerLauncher(root, '/node', '/entry', false)).toMatchObject({ conflict: join(root, 'bin/pulse') })
 } finally { await rm(root, { recursive: true, force: true }) }
})
it('generates a Windows launcher with bundled Node and preserves argument forwarding', () => {
 const text = launcherText('C:\\Pulse\\desktop\\runtime\\node.exe', 'C:\\Pulse\\desktop\\runtime\\app\\bin.js', 'C:\\Pulse', true)
 expect(text).toContain('DisableDelayedExpansion')
 expect(text).toContain('"%~dp0..\\desktop\\runtime\\node.exe"')
 expect(text).toContain('%*')
 expect(text).not.toMatch(/^node /m)
})
it.runIf(process.platform !== 'win32')('keeps in-bundle relative links usable after installation and rejects external links', async () => {
 const f = await fixture()
 try {
  await symlink('app/node_modules', join(f.source, 'modules'))
  await writeFile(join(f.source, '.DS_Store'), 'OS metadata')
  const manifest = await writeRuntimeManifest(f.source, '0.7.0')
  expect(manifest.files['.DS_Store']).toBeUndefined()
  const setup = new DesktopInstallation(f.options); await setup.prepare()
  await expect(verifyRuntime(setup.state.runtimeDirectory, manifest, true)).resolves.toBeUndefined()
  await symlink(f.root, join(f.source, 'outside'))
  await expect(writeRuntimeManifest(f.source, '0.7.0')).rejects.toThrow('RUNTIME_SYMLINK_NOT_ALLOWED')
 } finally { await rm(f.root, { recursive: true, force: true }) }
})
it('registers only the Windows user PATH using the system PowerShell even when PATH has no developer tools', async () => {
 let invocation: any[] = []
 await registerPath('C:\\Pulse\\bin', 'C:\\User', { SystemRoot: 'C:\\Windows', PATH: '' }, 'win32', async (...args: any[]) => { invocation = args })
 expect(invocation[0]).toContain('WindowsPowerShell')
 const script = Buffer.from(invocation[1].at(-1), 'base64').toString('utf16le')
 expect(script).toContain("'Path','User'")
 expect(script).not.toContain("'Machine'")
 expect(invocation[2].env.PULSE_SETUP_BIN).toBe('C:\\Pulse\\bin')
})
it.runIf(process.platform !== 'win32')('preserves bash login profile precedence', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-bash-path-'))
 try {
  await writeFile(join(root, '.profile'), 'export MY_USER_SETTING=keep\n')
  await registerPath(join(root, 'bin'), root, { SHELL: '/bin/bash' }, 'linux')
  expect(await readdir(root)).not.toContain('.bash_profile')
  expect(await readFile(join(root, '.profile'), 'utf8')).toContain('export MY_USER_SETTING=keep')
  await writeFile(join(root, '.bash_login'), '# Existing login\n')
  await registerPath(join(root, 'bin'), root, { SHELL: '/bin/bash' }, 'linux')
  expect(await readFile(join(root, '.bash_login'), 'utf8')).toContain('Pulse Desktop CLI')
 } finally { await rm(root, { recursive: true, force: true }) }
})

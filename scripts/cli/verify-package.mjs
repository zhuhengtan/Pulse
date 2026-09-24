import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const index = args.indexOf('--archive')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const version = JSON.parse(await readFile(join(repo, 'packages/cli/package.json'), 'utf8')).version
const archive = index >= 0 ? args[index + 1] : join(repo, 'artifacts/cli', `pulse-${version}.tar.gz`)
if (!archive) throw new Error('Usage: pnpm cli:verify-package [-- --archive <path>]')

const directory = await mkdtemp(join(tmpdir(), 'pulse-package-verify-'))
const extracted = spawnSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' })
if (extracted.status !== 0) process.exit(extracted.status ?? 1)

const bin = join(directory, 'pulse/bin/pulse.js')
const windowsInstall = await readFile(join(directory, 'pulse/install.ps1'), 'utf8')
const windowsUninstall = await readFile(join(directory, 'pulse/uninstall.ps1'), 'utf8')
if (!windowsInstall.includes('pulse.cmd') || !windowsInstall.includes('REM Pulse CLI managed launcher') || !windowsUninstall.includes('REM Pulse CLI managed launcher')) {
  throw new Error('Windows installer scripts are missing managed pulse.cmd support')
}
const packageManifest = JSON.parse(await readFile(join(directory, 'pulse/app/node_modules/@hunterzhu/pulse-cli/package.json'), 'utf8'))
const versionCheck = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
if (versionCheck.status !== 0 || versionCheck.stdout.trim() !== packageManifest.version) {
  console.error(`CLI version mismatch: expected ${packageManifest.version}, received ${versionCheck.stdout.trim()}`)
  if (versionCheck.error) console.error(`CLI spawn failed: ${versionCheck.error.message}`)
  if (versionCheck.stderr) console.error(versionCheck.stderr.trim())
  process.exit(versionCheck.status ?? 1)
}

const helpCheck = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
if (helpCheck.status !== 0) {
  console.error(helpCheck.stderr)
  process.exit(helpCheck.status ?? 1)
}

const cwd = join(directory, 'workspace')
await mkdir(cwd)
await writeFile(join(cwd, 'input.txt'), 'package verification\n')
const configPath = join(directory, 'config.json')
await writeFile(configPath, `${JSON.stringify({
  providers: { mock: { name: 'Mock', provider: 'mock' } },
  models: { mock: { displayName: 'mock', provider: 'mock', modelCode: 'mock' } },
  activeModel: 'mock',
  approvalMode: 'auto',
  allowNetwork: false,
  maxTurns: 32,
  autoCompactPercent: 90,
}, null, 2)}\n`)

const task = spawnSync(process.execPath, [bin, 'run', 'say hello', '--mock-response', 'package ok', '--mock-task-assessment', JSON.stringify([{ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-1'], rationale: 'The package output is present.' }] }]), '--cwd', cwd], {
  env: {
    ...process.env,
    PULSE_HOME: join(directory, 'home'),
    PULSE_CONFIG: configPath,
    PULSE_DATA_DIR: join(directory, 'data'),
  },
  encoding: 'utf8',
})
if (task.status !== 0) {
  console.error(task.stderr || task.stdout.slice(-4_000))
  process.exit(task.status ?? 1)
}

console.log('package verification passed')
const installRoot = join(directory, 'install-home')
const packagedRoot = join(directory, 'pulse')
const windows = process.platform === 'win32'
function installer(name) {
  return windows
    ? spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(packagedRoot, `${name}.ps1`)], { cwd: packagedRoot, env: { ...process.env, PULSE_HOME: installRoot }, encoding: 'utf8' })
    : spawnSync('sh', [join(packagedRoot, `${name}.sh`)], { cwd: packagedRoot, env: { ...process.env, PULSE_HOME: installRoot }, encoding: 'utf8' })
}
function launch(args, env) {
  if (!windows) return spawnSync(installedLauncher, args, { env, encoding: 'utf8' })
  return spawnSync('pwsh', ['-NoProfile', '-Command', '$launcherArgs = @(ConvertFrom-Json $env:PULSE_VERIFY_ARGS); & $env:PULSE_VERIFY_LAUNCHER @launcherArgs; exit $LASTEXITCODE'], {
    env: { ...env, PULSE_VERIFY_LAUNCHER: installedLauncher, PULSE_VERIFY_ARGS: JSON.stringify(args) }, encoding: 'utf8',
  })
}
const install = installer('install')
if (install.status !== 0) throw new Error(`package install failed: ${install.stderr || install.stdout}`)
const installedLauncher = join(installRoot, 'bin', windows ? 'pulse.cmd' : 'pulse')
const installedVersion = launch(['--version'], { ...process.env, PULSE_HOME: installRoot })
if (installedVersion.status !== 0 || installedVersion.stdout.trim() !== packageManifest.version) throw new Error('installed package launcher failed version check')
const scheduleEnv = { ...process.env, PULSE_HOME: installRoot, PULSE_CONFIG: configPath, PULSE_DATA_DIR: join(installRoot, 'data') }
const scheduled = launch(['schedule', 'add', '--every', '1h', '--name', 'Package smoke', 'Say hello'], scheduleEnv)
if (scheduled.status !== 0) throw new Error(`installed scheduler add command failed: ${scheduled.stderr || scheduled.stdout}`)
const scheduledList = launch(['schedule', 'list', '--format', 'jsonl'], scheduleEnv)
if (scheduledList.status !== 0 || !scheduledList.stdout.includes('Package smoke')) throw new Error('installed scheduler list command failed')
const preservedData = join(installRoot, 'data', 'preserve-marker.txt')
await mkdir(join(installRoot, 'data'), { recursive: true })
await writeFile(preservedData, 'preserve user data\n')
const uninstall = installer('uninstall')
if (uninstall.status !== 0) throw new Error(`package uninstall failed: ${uninstall.stderr || uninstall.stdout}`)
await access(preservedData)
await access(installedLauncher).then(() => { throw new Error('package uninstall left the managed launcher installed') }, (error) => { if (error.code !== 'ENOENT') throw error })
console.log('install and uninstall verification passed; user data remained intact')
await rm(directory, { recursive: true, force: true })

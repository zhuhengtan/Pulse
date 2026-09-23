import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const task = spawnSync(process.execPath, [bin, 'run', 'say hello', '--mock-response', 'package ok', '--cwd', cwd], {
  env: {
    ...process.env,
    PULSE_HOME: join(directory, 'home'),
    PULSE_CONFIG: configPath,
    PULSE_DATA_DIR: join(directory, 'data'),
  },
  encoding: 'utf8',
})
if (task.status !== 0) {
  console.error(task.stderr)
  process.exit(task.status ?? 1)
}

console.log('package verification passed')
await rm(directory, { recursive: true, force: true })

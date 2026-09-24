import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const windows = process.platform === 'win32'
const directory = await mkdtemp(join(tmpdir(), 'pulse-ci-'))
const home = join(directory, 'home')
const env = {
  ...process.env,
  PULSE_HOME: home,
  PULSE_CONFIG: join(home, 'config.json'),
  PULSE_DATA_DIR: join(home, 'data'),
  PULSE_CLI_ARTIFACTS_DIR: join(repo, 'artifacts/cli'),
  PULSE_INSPECTOR: '127.0.0.1:0',
  PULSE_INSPECT_BRK: '0',
}

function run(command, args, options = {}) {
  console.log(`\n[ci:local] ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: repo, env, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Check failed (${result.signal ?? result.status}): ${command} ${args.join(' ')}`)
}

// Only fixed script names/arguments reach the Windows command shell. Paths are
// passed directly to Node or through environment variables to PowerShell.
const pnpm = (...args) => run(windows ? 'pnpm.cmd' : 'pnpm', args, { shell: windows })
const node = (script, ...args) => run(process.execPath, [join(repo, script), ...args])

try {
  console.log(`Checking ${process.platform} with Node ${process.version}; temporary Pulse home: ${home}`)
  pnpm('check')
  pnpm('eval:validate')
  pnpm('release:check')
  pnpm('cli:build')
  node('packages/cli/scripts/postinstall.mjs')
  await access(env.PULSE_CONFIG)
  pnpm('--filter', '@hunterzhu/pulse-cli', 'exec', 'pulse', '--version')
  pnpm('--filter', '@hunterzhu/pulse-cli', 'exec', 'pulse', 'doctor', '--format', 'json')
  pnpm('cli:pack')
  // Verifies the packaged shell/PowerShell installers and user-data preservation.
  pnpm('cli:verify-package')

  // Also exercise the repository's Node installer on every supported platform.
  const { version } = JSON.parse(await readFile(join(repo, 'packages/cli/package.json'), 'utf8'))
  const archive = join(repo, 'artifacts/cli', `pulse-${version}.tar.gz`)
  const marker = join(env.PULSE_DATA_DIR, 'keep.txt')
  await mkdir(env.PULSE_DATA_DIR, { recursive: true })
  await writeFile(marker, 'preserve me\n')
  node('scripts/cli/install.mjs', '--archive', archive)
  const launcher = join(home, 'bin', windows ? 'pulse.cmd' : 'pulse')
  if (windows) {
    run('pwsh', ['-NoProfile', '-Command', '& $env:PULSE_CI_LAUNCHER --version; exit $LASTEXITCODE'], {
      env: { ...env, PULSE_CI_LAUNCHER: launcher },
    })
  } else {
    run(launcher, ['--version'])
  }
  node('scripts/cli/uninstall.mjs')
  await access(launcher).then(
    () => { throw new Error('Uninstall left the managed launcher installed') },
    error => { if (error.code !== 'ENOENT') throw error },
  )
  if (await readFile(marker, 'utf8') !== 'preserve me\n') throw new Error('Uninstall changed user data')

  node('scripts/cli/start.mjs', '--version')
  node('scripts/cli/dev.mjs', '--version')
  node('scripts/cli/debug.mjs', '--version')
  console.log(`\nLocal CI passed on ${process.platform}. No release was published.`)
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const windows = process.platform === 'win32'
const profile = process.argv.slice(2)
if (profile.length > 1 || profile.some(arg => arg !== '--windows-common')) throw Error('INVALID_CI_PROFILE')
const commonOnly = profile.length === 1
if (commonOnly && !windows) throw Error('WINDOWS_COMMON_REQUIRES_WINDOWS')
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
  const started = Date.now()
  const guarded = args.includes('check') || args.at(-1) === 'test' || args.includes('scripts/ci/test.mjs') || args.some(arg => arg.replaceAll('\\', '/').endsWith('/scripts/ci/test.mjs'))
  const testEnv = guarded ? { ...env, PULSE_CI_GUARD_OWNER: '1', PULSE_CI_NETWORK_LOG: join(directory, 'network-attempts.jsonl'), NODE_OPTIONS: (env.NODE_OPTIONS ?? '') + ' --import=' + join(repo, 'scripts/ci/network-guard.mjs') } : env
  const result = spawnSync(command, args, { cwd: repo, env: testEnv, stdio: 'inherit', ...options })
  const duration = Date.now() - started
  console.log(`[ci:timing] ${command} ${args.join(' ')} ${duration}ms`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${command} ${args.join(' ')}: ${duration}ms\n`)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Check failed (${result.signal ?? result.status}): ${command} ${args.join(' ')}`)
}

// Only fixed script names/arguments reach the Windows command shell. Paths are
// passed directly to Node or through environment variables to PowerShell.
const pnpm = (...args) => run(windows ? 'pnpm.cmd' : 'pnpm', args, { shell: windows })
const node = (script, ...args) => run(process.execPath, [join(repo, script), ...args])

try {
  console.log(`Checking ${process.platform} with Node ${process.version}; temporary Pulse home: ${home}`)
  if (process.platform === 'darwin') {
    // Tests require trusted host inventory, not a Homebrew/PATH substitute.
    // Pin only Git in this owned fixture PATH; keep product PATH checks strict.
    const tools = join(directory, 'host-tools')
    await access('/usr/bin/git')
    await mkdir(tools)
    await symlink('/usr/bin/git', join(tools, 'git'))
    env.PATH = `${tools}${delimiter}${env.PATH ?? ''}`
    console.log('[ci:local] Using fixed macOS system Git: /usr/bin/git')
  }
  await rm(join(repo, '.pulse-dev/ci-network-attempts.jsonl'), { force: true })
  pnpm('native:prepare')
  pnpm('build')
  if (commonOnly) {
    pnpm('--filter', '@hunterzhu/pulse-web', 'check')
    pnpm('--filter', '@hunterzhu/pulse-web', 'test')
  } else pnpm('check')
  pnpm('eval:validate')
  pnpm('site:check')
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
} finally {
  for (const file of [join(directory, 'network-attempts.jsonl'), join(repo, '.pulse-dev/ci-network-attempts.jsonl')]) {
    const attempts = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    if (attempts.trim()) { console.error('UNEXPECTED_CI_NETWORK_ATTEMPT:' + attempts); process.exitCode = 1 }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
if (process.exitCode) throw Error('CI_NETWORK_BOUNDARY_FAILED')
console.log(commonOnly ? 'Windows common checks passed. Backend shards are still required; this is not a full gate.' : `\nLocal CI passed on ${process.platform}. No release was published.`)

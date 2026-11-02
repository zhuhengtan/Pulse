import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { testTempEnvironment } from './test-temp.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const windows = process.platform === 'win32'
const shard = process.argv[2]
if (process.argv.length !== 3 || !/^[1-4]$/.test(shard) || !windows) throw Error('INVALID_WINDOWS_SHARD')
const directory = await mkdtemp(join(tmpdir(), 'pulse-ci-'))
const home = join(directory, 'home')
const fixtureTemp = await testTempEnvironment(directory)
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
  const testEnv = guarded ? { ...env, ...fixtureTemp, PULSE_CI_GUARD_OWNER: '1', PULSE_CI_NETWORK_LOG: join(directory, 'network-attempts.jsonl'), NODE_OPTIONS: (env.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(join(repo, 'scripts/ci/network-guard.mjs')).href } : env
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
  node('scripts/ci/workflow-env-contexts.mjs')
  pnpm('native:prepare')
  pnpm('build')
  node('scripts/ci/test.mjs', '--shard=' + shard)
} finally {
  for (const file of [join(directory, 'network-attempts.jsonl'), join(repo, '.pulse-dev/ci-network-attempts.jsonl')]) {
    const attempts = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    if (attempts.trim()) { console.error('UNEXPECTED_CI_NETWORK_ATTEMPT:' + attempts); process.exitCode = 1 }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
if (process.exitCode) throw Error('CI_NETWORK_BOUNDARY_FAILED')
console.log(`Windows backend shard ${shard}/4 passed; all other shards and common checks are required.`)

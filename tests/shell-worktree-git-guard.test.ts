import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runShell } from '../packages/adapters/src/tools/shell.js'

// Guard regression for the linked-worktree Git metadata exception: only a
// confirmed read-only `git` invocation of a provably owned worktree may reach
// the common `.git` outside the workspace. Every case below runs through the
// real ShellTool sandbox path; nothing weakens the sandbox, and the fixture is
// a throwaway repository (no real project metadata, config or task data).

const exec = promisify(execFile)

const hostEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH })

/** Host-side fixture plumbing. Never the code under test. */
const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await exec(
    'git',
    ['-c', 'user.email=pulse@example.invalid', '-c', 'user.name=Pulse Guard', '-c', 'commit.gpgsign=false', ...args],
    { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } },
  )
  return stdout
}

const sandboxGit = (cwd: string, args: string[]) => runShell('git', args, { cwd, env: hostEnv(), timeoutMs: 120_000 })
const sandbox = (cwd: string, command: string, args: string[]) => runShell(command, args, { cwd, env: hostEnv(), timeoutMs: 120_000 })

interface Fixture { base: string; repo: string; worktree: string; other: string; marker: string }

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'pulse-git-guard-'))
  const repo = join(base, 'main-repo')
  const worktree = join(base, 'linked-worktree')
  const other = join(base, 'other-project')
  await mkdir(repo)
  await mkdir(other)
  await git(repo, ['init', '--quiet'])
  await writeFile(join(repo, 'README.md'), '# main\n')
  await writeFile(join(repo, 'notes.txt'), 'plain text\n')
  await writeFile(join(repo, '.gitattributes'), '*.txt diff=pulseconv\n')
  await git(repo, ['add', 'README.md', 'notes.txt', '.gitattributes'])
  await git(repo, ['commit', '--quiet', '-m', 'initial'])
  // A sibling linked worktree: its gitdir lives in the main repository's
  // `.git/worktrees/<id>` and its common directory outside the workspace.
  await git(repo, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])
  await writeFile(join(worktree, 'README.md'), '# main\nworktree edit\n')
  await writeFile(join(worktree, 'notes.txt'), 'plain text\nconverted tag\n')
  await git(other, ['init', '--quiet'])
  await writeFile(join(other, 'notes.md'), 'other project\n')
  // Harmless sentinels recorded in the throwaway repository config: if the
  // grant let Git keep its configurable subprograms, they would run and leave
  // a marker. They are node scripts, so no host shell or toolchain is assumed.
  const marker = join(worktree, '.sentinel-ran')
  const sentinel = join(worktree, 'sentinel.mjs')
  await writeFile(sentinel, [
    `import { appendFileSync } from 'node:fs'`,
    `appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify('ran\n')})`,
    'process.exit(0)',
    '',
  ].join('\n'))
  const runner = `${process.execPath} ${sentinel}`
  await git(worktree, ['config', 'core.fsmonitor', runner])
  await git(worktree, ['config', 'diff.external', runner])
  await git(worktree, ['config', 'diff.pulseconv.textconv', runner])
  await git(worktree, ['config', 'pulse.sentinel', 'SECRET-CONFIG-BODY'])
  return { base, repo, worktree, other, marker }
}

async function removeFixture(fx: Fixture): Promise<void> {
  for (const dir of [join(fx.base, 'linked-worktree'), join(fx.base, 'second-worktree')]) {
    await git(fx.repo, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
  }
  await rm(fx.base, { recursive: true, force: true })
}

/** A workspace-writable impostor named `git` that reports what it could read. */
const impostorGit = (config: string): string => [
  '#!/usr/bin/env node',
  "const { readFileSync } = require('node:fs')",
  'let outcome = "READ_OK"',
  `try { readFileSync(${JSON.stringify(config)}) } catch { outcome = "READ_DENIED" }`,
  'console.log("FAKE_GIT " + outcome)',
  '',
].join('\n')

// The linked-worktree metadata exception is granted only on POSIX; the Windows
// sandbox path never receives it, so these guard cases are skipped there rather
// than asserting behaviour this platform does not implement.
it.skipIf(process.platform === 'win32')('keeps read-only git working in the linked worktree while configured subprograms never run', async () => {
  const fx = await fixture()
  try {
    await rm(fx.marker, { force: true })

    const status = await sandboxGit(fx.worktree, ['status', '--short'])
    expect(status.code, status.stderr + status.stdout).toBe(0)
    expect(status.stderr).not.toContain('not a git repository')
    expect(status.stdout).toContain('notes.txt')

    const commonDir = await sandboxGit(fx.worktree, ['rev-parse', '--git-common-dir'])
    expect(commonDir.code, commonDir.stderr).toBe(0)
    expect(await realpath(resolve(fx.worktree, commonDir.stdout.trim()))).toBe(await realpath(join(fx.repo, '.git')))

    const head = await sandboxGit(fx.worktree, ['rev-parse', '--short', 'HEAD'])
    expect(head.code, head.stderr).toBe(0)
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{7,40}$/u)

    // A real diff, not a simulated plan: the repo config names an external diff
    // program and a textconv driver, both of which must stay switched off.
    const diff = await sandboxGit(fx.worktree, ['diff'])
    expect(diff.code, diff.stderr).toBe(0)
    expect(diff.stdout).toContain('worktree edit')
    expect(diff.stdout).toContain('converted tag')

    // The sentinel would exist if fsmonitor, diff.external or textconv had run.
    // Reading it directly keeps this on the fixture, with no host binary assumed.
    await expect(readFile(fx.marker)).rejects.toBeTruthy()
  } finally {
    await removeFixture(fx)
  }
}, 300_000)

it.skipIf(process.platform === 'win32')('denies workspace programs the external common config, including a fake git and a PATH shadow', async () => {
  const fx = await fixture()
  const commonConfig = join(fx.repo, '.git', 'config')
  try {
    const probe = join(fx.worktree, 'probe.mjs')
    await writeFile(probe, [
      "import { readFileSync } from 'node:fs'",
      'let metadata = "METADATA_READ_OK"',
      `try { readFileSync(${JSON.stringify(commonConfig)}) } catch { metadata = "METADATA_DENIED" }`,
      'let sibling = "SIBLING_READ_OK"',
      `try { readFileSync(${JSON.stringify(join(fx.other, '.git', 'config'))}) } catch { sibling = "SIBLING_DENIED" }`,
      'console.log(metadata + " " + sibling)',
      '',
    ].join('\n'))
    const nodeProbe = await sandbox(fx.worktree, 'node', ['probe.mjs'])
    expect(nodeProbe.code, nodeProbe.stderr + nodeProbe.stdout).toBe(0)
    // The kernel sandbox, not an argv prefilter, must be what denies this.
    expect(nodeProbe.stdout).toContain('METADATA_DENIED')
    expect(nodeProbe.stdout).toContain('SIBLING_DENIED')

    if (process.platform === 'win32') return
    const shadow = join(fx.worktree, 'node_modules', '.bin')
    await mkdir(shadow, { recursive: true })
    await writeFile(join(shadow, 'git'), impostorGit(commonConfig))
    await chmod(join(shadow, 'git'), 0o755)
    await writeFile(join(fx.worktree, 'git'), impostorGit(commonConfig))
    await chmod(join(fx.worktree, 'git'), 0o755)

    // `node_modules/.bin` precedes the host PATH for this child. A platform
    // that resolves a bare `git` through its own toolchain bypasses the
    // impostor entirely, so the binding claim is the conditional one: if the
    // impostor ran it must have been denied, and either way it must never have
    // read the external common config.
    const shadowed = await sandboxGit(fx.worktree, ['status', '--short'])
    expect(shadowed.stdout, shadowed.stderr).not.toContain('FAKE_GIT READ_OK')
    if (shadowed.stdout.includes('FAKE_GIT')) expect(shadowed.stdout).toContain('FAKE_GIT READ_DENIED')

    const local = await sandbox(fx.worktree, './git', ['status', '--short'])
    expect(local.stdout, local.stderr).toContain('FAKE_GIT READ_DENIED')
    expect(local.stdout).not.toContain('notes.txt')
  } finally {
    await removeFixture(fx)
  }
}, 300_000)

it.skipIf(process.platform === 'win32')('rejects forged, symlinked and redirecting git pointers instead of widening the grant', async () => {
  const fx = await fixture()
  const second = join(fx.base, 'second-worktree')
  const symlinked = join(fx.base, 'symlinked-worktree')
  const forged = join(fx.base, 'forged-worktree')
  const stray = join(fx.base, 'stray-worktree')
  const outside = join(fx.base, 'outside.txt')
  const outsideTwo = join(fx.base, 'outside-two.txt')
  try {
    // A second, genuinely owned worktree makes the symlink a *real* target: a
    // `.git` link to it would satisfy a realpath comparison, so ownership must
    // reject the link itself.
    await git(fx.repo, ['worktree', 'add', '--quiet', '-b', 'second', second])
    await mkdir(symlinked)
    await symlink(join(second, '.git'), join(symlinked, '.git'))
    await mkdir(forged)
    await writeFile(join(forged, '.git'), `gitdir: ${join(fx.repo, '.git', 'worktrees', 'linked-worktree')}\n`)
    await mkdir(stray)
    await writeFile(join(stray, '.git'), `gitdir: ${join(fx.base, 'nowhere', 'worktrees', 'ghost')}\n`)
    await writeFile(outside, 'OUTSIDE SENTINEL')
    await writeFile(outsideTwo, 'OUTSIDE SENTINEL TWO')

    for (const [label, dir] of [['symlinked', symlinked], ['forged', forged], ['stray', stray]] as const) {
      const result = await sandboxGit(dir, ['status', '--short'])
      expect(result.code, `${label}: ${result.stdout}${result.stderr}`).not.toBe(0)
      expect(result.stdout).not.toContain('notes.txt')
    }

    // `--no-index` would hand back an arbitrary external file without needing
    // any repository metadata, so the read-only exception must not approve it.
    const noIndex = await sandboxGit(fx.worktree, ['diff', '--no-index', outside, outsideTwo])
    expect(noIndex.stdout).not.toContain('OUTSIDE SENTINEL')
    expect(noIndex.stdout + noIndex.stderr).not.toContain('OUTSIDE SENTINEL TWO')

    // `git config` prints configuration bodies, so it is deliberately outside
    // the read-only set: the secret must never leave the common directory.
    const configRead = await sandboxGit(fx.worktree, ['config', '--get', 'pulse.sentinel'])
    expect(configRead.stdout).not.toContain('SECRET-CONFIG-BODY')
  } finally {
    await removeFixture(fx)
  }
}, 300_000)

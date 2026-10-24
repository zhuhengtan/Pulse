import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runShell } from '../packages/adapters/src/tools/shell.js'

// Regression for the isolated shell hiding a linked worktree's git metadata.
// The fixture mirrors the reported failure exactly: the main repository and its
// common `.git` live outside the worktree, and inside the sandbox the worktree's
// immediate container is denied, so git must be granted only the two validated
// metadata directories.

const execGit = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await promisify(execFile)(
    'git',
    ['-c', 'user.email=pulse@example.invalid', '-c', 'user.name=Pulse Worktree', '-c', 'commit.gpgsign=false', ...args],
    { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } },
  )
  return stdout
}

const shellEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH })

const gitInSandbox = (cwd: string, args: string[]) => runShell('git', args, { cwd, env: shellEnv(), timeoutMs: 120_000 })

interface WorktreeFixture { base: string; repo: string; worktree: string; other: string }

async function worktreeFixture(): Promise<WorktreeFixture> {
  const base = await mkdtemp(join(tmpdir(), 'pulse-worktree-git-'))
  const repo = join(base, 'main-repo')
  const worktree = join(base, 'linked-worktree')
  const other = join(base, 'other-project')
  await mkdir(repo)
  await mkdir(other)
  await execGit(repo, ['init', '--quiet'])
  await writeFile(join(repo, 'README.md'), '# main\n')
  await execGit(repo, ['add', 'README.md'])
  await execGit(repo, ['commit', '--quiet', '-m', 'initial'])
  // The worktree is a sibling of the main repository, so its `.git` file points
  // outside the workspace at `<repo>/.git/worktrees/<id>`.
  await execGit(repo, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])
  await writeFile(join(worktree, 'README.md'), '# main\nworktree edit\n')
  await writeFile(join(worktree, 'worktree-only.txt'), 'worktree change\n')
  // An unrelated repository next to the workspace: nothing here may be read.
  await execGit(other, ['init', '--quiet'])
  await writeFile(join(other, 'notes.md'), 'other project\n')
  return { base, repo, worktree, other }
}

async function removeFixture(fx: WorktreeFixture): Promise<void> {
  await execGit(fx.repo, ['worktree', 'remove', '--force', fx.worktree]).catch(() => undefined)
  await rm(fx.base, { recursive: true, force: true })
}

// The linked-worktree metadata exception is granted only on POSIX; the Windows
// sandbox path never receives it, so these cases are skipped there rather than
// asserting behaviour this platform does not implement.
it.skipIf(process.platform === 'win32')('lets read-only git commands in a linked worktree reach the outside metadata', async () => {
  const fx = await worktreeFixture()
  try {
    const status = await gitInSandbox(fx.worktree, ['status', '--short'])
    expect(status.code, status.stderr + status.stdout).toBe(0)
    expect(status.stderr).not.toContain('not a git repository')
    expect(status.stdout).toContain('worktree-only.txt')
    expect(status.stdout).toContain('README.md')

    const commonDir = await gitInSandbox(fx.worktree, ['rev-parse', '--git-common-dir'])
    expect(commonDir.code, commonDir.stderr).toBe(0)
    const reportedCommon = await realpath(resolve(fx.worktree, commonDir.stdout.trim()))
    expect(reportedCommon).toBe(await realpath(join(fx.repo, '.git')))

    const head = await gitInSandbox(fx.worktree, ['rev-parse', '--short', 'HEAD'])
    expect(head.code, head.stderr).toBe(0)
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{7,40}$/u)

    const diff = await gitInSandbox(fx.worktree, ['diff'])
    expect(diff.code, diff.stderr).toBe(0)
    expect(diff.stdout).toContain('worktree edit')
  } finally {
    await removeFixture(fx)
  }
}, 240_000)

it.skipIf(process.platform === 'win32')('keeps external reads and forged git pointers denied in the same sandbox', async () => {
  const fx = await worktreeFixture()
  const outside = join(fx.base, 'outside.txt')
  const forged = join(fx.base, 'forged-worktree')
  const stray = join(fx.base, 'stray-worktree')
  await writeFile(outside, 'OUTSIDE SENTINEL')
  await mkdir(forged)
  await mkdir(stray)
  // A forged `.git` file naming another worktree's real administrative
  // directory: the backlink there points at a different workspace.
  await writeFile(join(forged, '.git'), `gitdir: ${join(fx.repo, '.git', 'worktrees', 'linked-worktree')}\n`)
  // A gitdir pointing at a path that is not a worktree layout at all.
  await writeFile(join(stray, '.git'), `gitdir: ${join(fx.base, 'missing', 'worktrees', 'ghost')}\n`)
  try {
    const probe = join(fx.worktree, 'probe.mjs')
    await writeFile(probe, [
      "import { readFileSync } from 'node:fs'",
      "import assert from 'node:assert/strict'",
      `assert.throws(() => readFileSync(${JSON.stringify(outside)}), 'sibling file read')`,
      `assert.throws(() => readFileSync(${JSON.stringify(join(fx.other, '.git', 'config'))}), 'other repository config read')`,
      "console.log('EXTERNAL_READS_DENIED')",
    ].join('\n'))
    const nodeProbe = await runShell('node', ['probe.mjs'], { cwd: fx.worktree, env: shellEnv(), timeoutMs: 120_000 })
    expect(nodeProbe.code, nodeProbe.stderr + nodeProbe.stdout).toBe(0)
    expect(nodeProbe.stdout).toContain('EXTERNAL_READS_DENIED')

    if (process.platform !== 'win32') {
      const cat = await runShell('cat', [outside], { cwd: fx.worktree, env: shellEnv(), timeoutMs: 120_000 })
      expect(cat.code).not.toBe(0)
      expect(cat.stdout).not.toContain('OUTSIDE SENTINEL')
    }

    for (const dir of [forged, stray]) {
      const result = await gitInSandbox(dir, ['status', '--short'])
      expect(result.code, `${dir}: ${result.stdout}${result.stderr}`).not.toBe(0)
      expect(result.stdout).not.toContain('worktree-only.txt')
    }
  } finally {
    await removeFixture(fx)
  }
}, 240_000)

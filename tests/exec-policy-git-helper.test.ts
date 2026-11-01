import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveShellIdentity, runShell } from '../packages/adapters/src/tools/shell.js'
import { ExecPolicyHost } from '../packages/server/src/exec-policy-host.js'
import { createLocalHost } from '@hunterzhu/pulse-server'

// Remembered git status/diff/log must not start repository helpers. The fixture
// is a throwaway repository; host setup never runs the sentinel.

const exec = promisify(execFile)
const git = (cwd: string, args: string[]) => exec('git', ['-c', 'user.email=pulse@example.invalid', '-c', 'user.name=Pulse Guard', '-c', 'commit.gpgsign=false', ...args], {
  cwd, timeout: 30_000, env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
})

it.skipIf(process.platform === 'win32')('remembered git status, diff, and log do not run repository helpers', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pulse-policy-git-helper-'))
  const repo = join(base, 'repo')
  const worktree = join(base, 'linked')
  const marker = join(repo, 'unexpected-script')
  try {
    await mkdir(repo)
    await git(repo, ['init', '--quiet'])
    await writeFile(join(repo, 'README.md'), '# main\n')
    await writeFile(join(repo, 'notes.txt'), 'plain text\n')
    await git(repo, ['add', 'README.md', 'notes.txt'])
    await git(repo, ['commit', '--quiet', '-m', 'initial'])
    const sentinel = join(repo, 'sentinel.mjs')
    await writeFile(sentinel, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(marker)}, 'ran\\n')\nprocess.exit(0)\n`)
    await chmod(sentinel, 0o755)
    const runner = `${process.execPath} ${sentinel}`
    await writeFile(join(repo, '.gitattributes'), '*.txt diff=pulseconv\n*.txt filter=evil\n')
    await git(repo, ['config', 'core.fsmonitor', runner])
    await git(repo, ['config', 'diff.external', runner])
    await git(repo, ['config', 'diff.pulseconv.textconv', runner])
    await git(repo, ['config', 'filter.evil.clean', runner])
    await writeFile(join(repo, 'notes.txt'), 'plain text\nconverted tag\n')
    const gitIdentity = await resolveShellIdentity('git', ['status', '--short'], repo)
    const host = new ExecPolicyHost({ hostExecutables: { git: [gitIdentity.path] } })
    const run = async (cwd: string, args: string[]) => {
      const command = { command: 'git', args }
      const id = `call-${args.join('-')}`
      const input = { tools: [{ toolName: 'shell.exec', toolCallId: id, input: command }] }
      const offer = await host.offer(input, cwd, 'c', 'r', `offer-${id}`)
      expect(offer?.prefix).toEqual(['git', ...args])
      await host.approve(input, cwd, 'c', 'r', `offer-${id}`, { remember: 'session', execPolicyToken: offer!.token })
      expect(await host.authorize(command, cwd, 'c', 'r', id)).toBe(true)
      const identity = host.identity('c', 'r', id)
      return runShell('git', args, {
        cwd, timeoutMs: 120_000, env: { PATH: process.env.PATH }, expectedIdentity: identity,
        beforeLaunch: async () => { await host.authorize(command, cwd, 'c', 'r', id); return host.identity('c', 'r', id) },
      })
    }
    expect(await host.offer({ tools: [{ toolName: 'shell.exec', toolCallId: 'open', input: { command: 'git', args: ['log'] } }] }, repo, 'c', 'r', 'open-log')).toBeUndefined()
    const status = await run(repo, ['status', '--short'])
    expect(status.code, status.stderr + status.stdout).toBe(0)
    expect(await host.authorize({ command: 'git', args: ['status'] }, repo, 'c', 'r', 'widened-status')).toBe(false)
    const diff = await run(repo, ['diff'])
    expect(diff.code, diff.stderr + diff.stdout).toBe(0)
    expect(diff.stdout).toContain('converted tag')
    expect(await host.authorize({ command: 'git', args: ['diff', '--cached'] }, repo, 'c', 'r', 'widened-diff')).toBe(false)
    const log = await run(repo, ['log', '-1', '--oneline'])
    expect(log.code, log.stderr + log.stdout).toBe(0)
    expect(await host.authorize({ command: 'git', args: ['log'] }, repo, 'c', 'r', 'widened-log')).toBe(false)
    await expect(readFile(marker, 'utf8')).rejects.toBeTruthy()
    await git(repo, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])
    await rm(marker, { force: true })
    const linkedStatus = await run(worktree, ['status', '--short'])
    expect(linkedStatus.code, linkedStatus.stderr + linkedStatus.stdout).toBe(0)
    // log is not given the linked-worktree metadata root. It must fail closed
    // on the external gitdir and still must not start the repository helper.
    const linkedLog = await run(worktree, ['log', '-1', '--oneline'])
    expect(linkedLog.code, linkedLog.stderr).not.toBe(0)
    expect(linkedLog.stderr).toMatch(/not a git repository|gitfile does not point to a valid repository/)
    await expect(readFile(marker, 'utf8')).rejects.toBeTruthy()
  } finally {
    await git(repo, ['worktree', 'remove', '--force', worktree]).catch(() => undefined)
    await rm(base, { recursive: true, force: true })
  }
}, 180_000)

it.skipIf(process.platform === 'win32')('does not run a workspace, absolute, or PATH impostor git on the host, including after approval', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pulse-policy-fake-git-'))
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  const marker = join(outside, 'unsandboxed-marker')
  await mkdir(workspace)
  await mkdir(outside)
  const impostor = async (file: string) => {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 0\n`)
    await chmod(file, 0o755)
  }
  const absent = () => expect(readFile(marker, 'utf8')).rejects.toBeTruthy()
  try {
    await git(workspace, ['init', '--quiet'])
    const relative = join(workspace, 'git')
    await impostor(relative)
    const relativeRun = await runShell('./git', ['status', '--short'], { cwd: workspace, env: { PATH: process.env.PATH }, timeoutMs: 60_000 })
    expect(relativeRun.code, relativeRun.stderr).toBe(0)
    await absent()
    const absoluteRun = await runShell(relative, ['status', '--short'], { cwd: workspace, env: { PATH: process.env.PATH }, timeoutMs: 60_000 })
    expect(absoluteRun.code, absoluteRun.stderr).toBe(0)
    await absent()
    const shadow = join(workspace, 'node_modules', '.bin')
    await impostor(join(shadow, 'git'))
    const shadowed = await runShell('git', ['status', '--short'], { cwd: workspace, env: { PATH: `${shadow}${delimiter}${process.env.PATH ?? ''}` }, timeoutMs: 60_000 })
    expect(shadowed.stdout + shadowed.stderr).not.toContain('invoked')
    await absent()
    const shadowPath = await runShell(join(shadow, 'git'), ['status', '--short'], { cwd: workspace, env: { PATH: process.env.PATH }, timeoutMs: 60_000 })
    expect(shadowPath.code, shadowPath.stderr).toBe(0)
    await absent()
    const host = createLocalHost({ cwd: workspace, dataDir: join(base, 'data'), provider: { provider: 'mock' }, taskController: false, approvalMode: 'ask', mockToolCalls: [{ name: 'shell.exec', input: { command: './git', args: ['status', '--short'] } }], mockAfterToolResponse: 'Checked.' })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Check status with the workspace git.' })
      for await (const event of run.events) if (event.type === 'waiting') await run.reply((event.data as { effectId: string }).effectId, { approved: true })
      expect((await run.outcome()).status).toBe('succeeded')
      await absent()
    } finally { await host.close() }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}, 180_000)

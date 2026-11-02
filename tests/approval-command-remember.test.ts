import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import * as adapters from '@hunterzhu/pulse-adapters'
import { ExecPolicyHost } from '../packages/server/src/exec-policy-host.js'
import { isBoundedWorkspaceRead } from '../packages/server/src/verification-policy.js'
it('offers and remembers every safe shell command in a mixed batch, then rechecks path safety', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-command-remember-'))
  // This is a policy/persistence fixture, not executable discovery: Windows
  // does not provide trusted POSIX ls/cat. Real launches remain covered by the
  // native exec-policy-production suite on every supported platform.
  const resolved = async (command: string) => {
    if (!['ls', 'cat'].includes(command)) throw new Error('UNEXPECTED_FIXTURE_COMMAND')
    const path = join(root, 'host-inventory', command)
    return { executable: path, prefixArgs: [], path, fingerprint: `fixture-host:${command}`, trusted: true }
  }
  const identities = vi.spyOn(adapters, 'resolveShellIdentity').mockImplementation(resolved)
  try {
    await mkdir(join(root, 'src')); await writeFile(join(root, 'src/notes.txt'), 'ordinary source')
    const config = join(root, 'config.json'); await writeFile(config, '{}')
    const policy = new ExecPolicyHost({}, config)
    const tools = [{ toolName: 'fs.read', input: { path: 'src/notes.txt' } }, { toolCallId: 'ls-1', toolName: 'shell.exec', input: { command: 'ls', args: ['-la', 'src'] } }, { toolCallId: 'cat-1', toolName: 'shell.exec', input: { command: 'cat', args: ['src/notes.txt'] } }]
    identities.mockRejectedValueOnce(new Error('EXEC_POLICY_PROGRAM_UNRESOLVED'))
    expect(await policy.offer({ tools }, root, 'conversation', 'run1', 'unresolved')).toBeUndefined()
    identities.mockImplementationOnce(async command => ({ ...await resolved(command), trusted: false }))
    expect(await policy.offer({ tools }, root, 'conversation', 'run1', 'untrusted')).toBeUndefined()
    const offer = await policy.offer({ tools }, root, 'conversation', 'run1', 'effect1')
    expect(offer?.commands).toEqual([['ls', '-la', 'src'], ['cat', 'src/notes.txt']])
    await policy.approve({ tools }, root, 'conversation', 'run1', 'effect1', { approved: true, remember: 'permanent', execPolicyToken: offer!.token })
    expect(JSON.parse(await readFile(config, 'utf8')).execPolicy.rules).toHaveLength(2)
    const restarted = new ExecPolicyHost({}, config)
    expect(await restarted.authorize({ command: 'ls', args: ['-la', 'src'] }, root, 'conversation', 'run2', 'ls-2')).toBe(true)
    expect(await restarted.authorize({ command: 'cat', args: ['src/notes.txt'] }, root, 'conversation', 'run2', 'cat-2')).toBe(true)
    expect(await restarted.authorize({ command: 'ls', args: ['src'] }, root, 'conversation', 'run2', 'ls-3')).toBe(false)
    await writeFile(join(root, '.env'), 'private'); await unlink(join(root, 'src/notes.txt')); await symlink(join(root, '.env'), join(root, 'src/notes.txt'))
    await expect(restarted.authorize({ command: 'cat', args: ['src/notes.txt'] }, root, 'conversation', 'run2', 'cat-3')).rejects.toThrow('EXEC_POLICY_PROMPT')
  } finally { identities.mockRestore(); await rm(root, { recursive: true, force: true }) }
})
it('auto-passes only bounded workspace reads and preserves explicit prompt/forbidden rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-command-reads-'))
  try {
    await writeFile(join(root, 'notes.txt'), 'ordinary'); await writeFile(join(root, 'big.txt'), 'x'.repeat(65537)); await writeFile(join(root, '.env'), 'private')
    for (const input of [{ command: 'ls', args: ['-la', '.'] }, { command: 'cat', args: ['notes.txt'] }, { command: 'pwd', args: [] }]) expect(await isBoundedWorkspaceRead(root, input)).toBe(true)
    for (const input of [{ command: 'cat', args: ['.env'] }, { command: 'cat', args: ['big.txt'] }, { command: 'cat', args: [] }, { command: 'cat', args: ['/etc/passwd'] }, { command: 'ls', args: ['-R', '.'] }, { command: 'ls', args: ['--color=always'] }, { command: 'cat', args: ['--', '.env'] }]) expect(await isBoundedWorkspaceRead(root, input)).toBe(false)
    const policy = new ExecPolicyHost({ rules: [{ pattern: ['ls'], decision: 'prompt' }] })
    expect(await policy.offer({ tools: [{ toolName: 'shell.exec', input: { command: 'ls', args: ['.'] } }] }, root, 'c', 'r', 'e')).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { captureCheck } from '../packages/server/src/check-receipt.js'
import { workspaceStamp } from '../packages/server/src/task-controller/checkpoint.js'

const exec = promisify(execFile)
const absent = (path: string) => expect(readFile(path, 'utf8')).rejects.toBeTruthy()

describe.sequential.skipIf(process.platform === 'win32')('host git inventory does not run repository helpers', () => {
  it('keeps a rejected LocalHost task from running fsmonitor before approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-policy-host-git-'))
    const marker = join(root, 'hook-ran')
    try {
      await exec('/usr/bin/git', ['init', '-q'], { cwd: root })
      await writeFile(join(root, 'monitor.sh'), `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\nprintf "token\\0"\n`)
      await chmod(join(root, 'monitor.sh'), 0o755)
      await exec('/usr/bin/git', ['config', 'core.fsmonitor', join(root, 'monitor.sh')], { cwd: root })
      const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: { provider: 'mock' }, jarvis: { enabled: false }, taskController: false, approvalMode: 'ask', mockToolCalls: [{ name: 'fs.list', input: { path: '.' } }], mockAfterToolResponse: 'Done.' })
      try {
        const conversation = await host.createConversation()
        await absent(marker)
        const run = await host.sendMessage(conversation.id, { text: 'List local files, do not execute commands.' })
        let rejected = false
        for await (const event of run.events) if (event.type === 'waiting') { rejected = true; await run.reply((event.data as { effectId: string }).effectId, { approved: false }) }
        await run.outcome()
        expect(rejected).toBe(true)
        await absent(marker)
      } finally { await host.close() }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60_000)

  it('stamps and inventories a repository without running its fsmonitor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-policy-host-stamp-'))
    const marker = join(root, 'hook-ran')
    const script = `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\nprintf "token\\0"\n`
    try {
      await exec('/usr/bin/git', ['init', '-q'], { cwd: root })
      await writeFile(join(root, 'monitor.sh'), script)
      await chmod(join(root, 'monitor.sh'), 0o755)
      await exec('/usr/bin/git', ['config', 'core.fsmonitor', join(root, 'monitor.sh')], { cwd: root })
      await writeFile(join(root, 'clean.sh'), `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\ncat\n`)
      await chmod(join(root, 'clean.sh'), 0o755)
      await exec('/usr/bin/git', ['config', 'filter.probe.clean', join(root, 'clean.sh')], { cwd: root })
      const stamp = await workspaceStamp(root)
      const receipt = await captureCheck(root, root, 'node', ['--test'], false, 4)
      expect(stamp.available).toBe(true)
      expect(stamp.files['monitor.sh']).toBe(createHash('sha256').update(script).digest('hex'))
      expect(receipt.files['monitor.sh']).toBeTruthy()
      await absent(marker)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60_000)

  it('does not execute a PATH impostor for a non-git inventory or a checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-policy-host-impostor-'))
    const shadow = join(root, 'shadow')
    const marker = join(root, 'outside-marker')
    const saved = process.env.PATH
    try {
      await exec('/usr/bin/git', ['init', '-q'], { cwd: root })
      await writeFile(join(root, 'keep.txt'), 'kept')
      await mkdir(shadow)
      await writeFile(join(shadow, 'git'), `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 0\n`)
      await chmod(join(shadow, 'git'), 0o755)
      process.env.PATH = shadow
      expect((await workspaceStamp(root)).available).toBe(false)
      const plain = await mkdtemp(join(tmpdir(), 'pulse-policy-host-plain-'))
      try {
        await writeFile(join(plain, 'feature.mjs'), 'export const value = 1\n')
        const receipt = await captureCheck(plain, plain, 'node', ['--test'], false, 4)
        expect(receipt.files['feature.mjs']).toBeTruthy()
      } finally { await rm(plain, { recursive: true, force: true }) }
      await absent(marker)
    } finally {
      process.env.PATH = saved
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not accept a git alias of /usr/bin/true as an unchanged stamp', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pulse-policy-git-alias-'))
    const workspace = join(base, 'workspace')
    const shadow = join(base, 'shadow')
    const saved = process.env.PATH
    try {
      await mkdir(workspace)
      await mkdir(shadow)
      await exec('/usr/bin/git', ['init', '-q'], { cwd: workspace })
      await writeFile(join(workspace, 'keep.txt'), 'before')
      const real = await workspaceStamp(workspace)
      expect(real.available).toBe(true)
      expect(real.files['keep.txt']).toBe(createHash('sha256').update('before').digest('hex'))
      await symlink('/usr/bin/true', join(shadow, 'git'))
      process.env.PATH = `${shadow}${delimiter}${saved ?? ''}`
      const before = await workspaceStamp(workspace)
      await writeFile(join(workspace, 'keep.txt'), 'after')
      const after = await workspaceStamp(workspace)
      expect(before.available).toBe(false)
      expect(after.available).toBe(false)
      expect(before.digest).toBeUndefined()
      expect(after.digest).toBeUndefined()
    } finally {
      process.env.PATH = saved
      await rm(base, { recursive: true, force: true })
    }
  }, 60_000)
})

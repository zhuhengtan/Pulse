import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { resolveShellIdentity, runShell } from '@hunterzhu/pulse-adapters'
import { agentPtyShellOptions } from '../packages/server/src/agent-pty.js'

// This suite deliberately requires the real Windows native modules and an
// already provisioned SRT. A platform mock is not ConPTY/Job acceptance.
// skipIf(process.platform !== 'win32') is not a pass: other platforms do not run it.
it.skipIf(process.platform !== 'win32')('cancels a Windows ConPTY descendant tree through the original SRT broker and Job', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-conpty-tree-')))
  const controller = new AbortController(), marker = join(root, 'heartbeat.txt')
  const child = join(root, 'child.cjs'), parent = join(root, 'parent.cjs')
  await writeFile(child, "const fs=require('fs');setInterval(()=>fs.writeFileSync(process.argv[2],String(Date.now())),30)")
  await writeFile(parent, "const p=require('child_process').spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'inherit'});console.log('target-tty:'+process.stdin.isTTY);setInterval(()=>{},1000)")
  let running: Promise<unknown> | undefined
  try {
    const identity = await resolveShellIdentity('node', [parent, child, marker], root)
    running = runShell('node', [parent, child, marker], { cwd: root, expectedIdentity: identity, signal: controller.signal, timeoutMs: 15000, allowedDomains: [], ...agentPtyShellOptions(() => {}) })
    await expect.poll(async () => readFile(marker, 'utf8').catch(() => ''), { timeout: 180000 }).not.toBe('')
    controller.abort()
    const result = await running as { aborted: boolean; stdout: string }
    expect(result.aborted).toBe(true); expect(result.stdout).toContain('target-tty:true')
    const stopped = await readFile(marker, 'utf8')
    await delay(250)
    expect(await readFile(marker, 'utf8')).toBe(stopped)
  } finally { controller.abort(); await running?.catch(() => {}); await rm(root, { recursive: true, force: true }) }
}, 300000)

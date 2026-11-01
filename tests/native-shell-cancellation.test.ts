import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemTool, runShell } from '@hunterzhu/pulse-adapters'
describe('native filesystem and shell contracts', () => {
it('cancels a shell process group instead of leaving a spawned child running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-shell-'))
    const marker = join(root, 'leaked.txt')
    const script = 'const {spawn}=require("node:child_process"); const fs=require("node:fs"); spawn(process.execPath,["-e",`setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},"leaked"),400)`],{stdio:"ignore"}); setTimeout(()=>{},10000)'
    const controller = new AbortController()
    const pending = runShell(process.execPath, ['-e', script], { signal: controller.signal })
    setTimeout(() => controller.abort(), 25)
    await pending
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })
it('reports shell timeout and escalates after the grace period', async () => {
    const result = await runShell(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 25 })
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })
})

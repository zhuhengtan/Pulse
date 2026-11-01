import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemTool, runShell } from '@hunterzhu/pulse-adapters'

// Keep long native cold starts separate from pure model/adapter contracts.
// All four cases still run exactly once through the unfiltered full CI suite.
describe('native filesystem and shell contracts', () => {
  it('enforces filesystem sandbox and runs bounded shell output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-m3-'))
    const sibling = await mkdtemp(join(tmpdir(), 'pulse-m3-sibling-'))
    const privateProfile = process.platform === 'win32' ? await mkdtemp(join(homedir(), 'pulse-private-profile-')) : undefined
    try {
      const filesystem = new FilesystemTool(root)
      await filesystem.write('nested/file.txt', 'ok')
      await expect(filesystem.read('nested/file.txt')).resolves.toBe('ok')
      await expect(filesystem.read('../outside.txt')).rejects.toThrow('PATH_OUTSIDE_SANDBOX')
      const result = await runShell(process.execPath, ['-e', 'process.stdout.write("hello")'], { cwd: root, maxOutputBytes: 3 })
      expect(result.stdout).toBe('hel')
      expect(result.truncated).toBe(true)
      const unicode = await runShell(process.execPath, ['-e', 'process.stdout.write("雪雪")'], { cwd: root, maxOutputBytes: 4 })
      expect(unicode.stdout).toBe('雪')
      expect(Buffer.byteLength(unicode.stdout, 'utf8')).toBeLessThanOrEqual(4)
      expect(unicode.truncated).toBe(true)
      const argv = ['', 'two words', `quote'" ; $(touch ${join(root, 'injected')})`, 'line\nbreak', '雪']
      const echoed = await runShell(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...argv], { cwd: root })
      expect(echoed.code, echoed.stderr).toBe(0)
      expect(JSON.parse(echoed.stdout)).toEqual(argv)
      await expect(readFile(join(root, 'injected'), 'utf8')).rejects.toThrow()
      const created = await runShell('node', ['-e', 'const fs=require("node:fs");fs.mkdirSync("created/deep",{recursive:true});fs.writeFileSync("created/deep/file.txt","nested write");process.stdout.write(fs.readFileSync("created/deep/file.txt","utf8"))'], { cwd: root })
      expect(created.code, created.stderr).toBe(0)
      expect(created.stdout).toBe('nested write')
      const reread = await runShell('node', ['-e', 'process.stdout.write(require("node:fs").readFileSync("created/deep/file.txt","utf8"))'], { cwd: root })
      expect(reread.code, reread.stderr).toBe(0)
      expect(reread.stdout).toBe('nested write')
      const secretPath = join(sibling, 'secret.txt')
      await writeFile(secretPath, 'outside workspace', 'utf8')
      const isolated = await runShell(process.execPath, ['-e', 'const fs=require("node:fs");let result=[];for(const p of process.argv.slice(1)){try{result.push(fs.readFileSync(p,"utf8"))}catch(e){result.push(e.code||"blocked")};try{fs.writeFileSync(p,"changed");result.push("wrote")}catch(e){result.push(e.code||"blocked")}}process.stdout.write(JSON.stringify(result))', secretPath, join(sibling, 'new.txt')], { cwd: root })
      expect(isolated.code, isolated.stderr).toBe(0)
      const isolationResults = JSON.parse(isolated.stdout) as string[]
      expect(isolationResults[0]).not.toBe('outside workspace')
      expect(isolationResults[1]).not.toBe('wrote')
      expect(isolationResults[2]).not.toBe('wrote')
      expect(await readFile(secretPath, 'utf8')).toBe('outside workspace')
      if (privateProfile) {
        const privateFile = join(privateProfile, 'secret.txt')
        await writeFile(privateFile, 'private host profile')
        const profileAccess = await runShell('node', ['-e', 'const fs=require("node:fs");const p=process.argv[1];let r=[];try{r.push(fs.readFileSync(p,"utf8"))}catch{r.push("blocked")};try{fs.writeFileSync(p,"changed");r.push("wrote")}catch{r.push("blocked")};process.stdout.write(JSON.stringify(r))', privateFile], { cwd: root })
        expect(profileAccess.code, profileAccess.stderr).toBe(0)
        expect(JSON.parse(profileAccess.stdout)).toEqual(['blocked', 'blocked'])
        expect(await readFile(privateFile, 'utf8')).toBe('private host profile')
      }
      expect(await readFile(join(root, 'nested/file.txt'), 'utf8')).toBe('ok')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(sibling, { recursive: true, force: true })
      if (privateProfile) await rm(privateProfile, { recursive: true, force: true })
    }
  // Seven cold Windows launches include ACL setup and teardown, not just the
  // command timeout. Do not abandon a live policy halfway through this test.
  }, process.platform === 'win32' ? 1_200_000 : 60_000)

  it('runs the installed development toolchain inside the sandbox by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse toolchain 雪-'))
    try {
      if (process.env.CI && process.platform === 'win32') expect(process.env.PNPM_HOME, 'CI must expose the pnpm setup shim directory').toBeTruthy()
      for (const [command, args] of [['node', ['--version']], ['pnpm', ['--version']], ['git', ['init', '--quiet']], ['git', ['status', '--porcelain']]] as const) {
        if (process.env.CI) console.info(`[sandbox toolchain] starting ${command} ${args.join(' ')}`)
        const result = await runShell(command, [...args], { cwd: root, timeoutMs: 30_000 })
        if (process.env.CI) console.info(`[sandbox toolchain] ${command} exited ${result.code}`)
        expect(result.code, `${command}; PNPM_HOME=${process.env.PNPM_HOME ?? '(unset)'}: ${result.stderr}`).toBe(0)
        if (command === 'pnpm' && process.env.PULSE_EXPECTED_PNPM_VERSION) expect(result.stdout.trim()).toBe(process.env.PULSE_EXPECTED_PNPM_VERSION)
        expect(result.stderr).not.toContain('Operation not permitted')
      }
      const child = await runShell('node', ['-e', 'const c=require("node:child_process").spawnSync("node",["--version"],{encoding:"utf8"});process.stdout.write(c.stdout||"");process.exit(c.status??1)'], { cwd: root })
      expect(child.code, child.stderr).toBe(0)
      expect(child.stdout).toMatch(/^v\d+/)
    } finally { await rm(root, { recursive: true, force: true }) }
  // Each Windows command provisions its own isolated ACL policy before the
  // child timeout starts. Five cold launches include policy restoration as well as child execution.
  // Hosted Windows runners measured 105–146 seconds per complete launch; keep
  // the five-command test bounded without cutting off its final initialization.
  }, process.platform === 'win32' ? 900_000 : 60_000)

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

import { afterEach, expect, it } from 'vitest'
import { ScenarioProcesses, type ScenarioProcessResult } from './cli-scenario-process.js'

let processes = new ScenarioProcesses()
afterEach(async () => { await processes.dispose(); expect(processes.activeCount).toBe(0); processes = new ScenarioProcesses() })

it('collects real child output and clears ownership before resolving', async () => {
  const result = await processes.run(process.execPath, ['-e', 'process.stdout.write("ready");process.stderr.write("diagnostic")'], { timeoutMs: 5_000 })
  expect(result).toMatchObject({ code: 0, signal: null, stdout: 'ready', stderr: 'diagnostic' })
  expect(result.firstOutputMs).toBeGreaterThanOrEqual(0)
  expect(processes.activeCount).toBe(0)
})

it('rejects a deadline and reaps a child even if it ignores SIGTERM', async () => {
  let closed: ScenarioProcessResult | undefined
  const pending = processes.run(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'], {
    timeoutMs: 5_000, killGraceMs: 100, onClose: result => { closed = result },
  })
  await expect(pending).rejects.toThrow('CLI_CHILD_DEADLINE')
  expect(closed?.stdout).toBe('ready')
  expect(processes.activeCount).toBe(0)
  if (process.platform !== 'win32') expect(closed?.signal).toBe('SIGKILL')
})

it('cleanup rejects and reaps pending work, and rejects later launches', async () => {
  const pending = processes.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 5_000 })
  const rejected = expect(pending).rejects.toThrow('CLI_SCENARIO_CLEANUP')
  await processes.dispose()
  await rejected
  expect(processes.activeCount).toBe(0)
  await expect(processes.run(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5_000 })).rejects.toThrow('CLI_SCENARIO_DISPOSED')
})

it('reports a spawn error without retaining ownership', async () => {
  await expect(processes.run('pulse-scenario-deliberately-absent-executable', [], { timeoutMs: 5_000 })).rejects.toThrow('ENOENT')
  expect(processes.activeCount).toBe(0)
})

// The PID comes from the real fixture, not activeCount or a mocked kill call.
function grandchildFixture(detached: boolean, earlyExit = false): string {
  const leaf = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
  const middle = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:${detached},stdio:'ignore'});console.log('leaf:'+c.pid);setInterval(()=>{},1000)`
  return `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','pipe','pipe']});c.stdout.pipe(process.stdout);setInterval(()=>{},1000);${earlyExit ? 'setTimeout(()=>process.exit(0),700)' : ''}`
}

async function startFixture(script: string, timeoutMs = 5_000) {
  let resolvePid!: (pid: number) => void
  const pidReady = new Promise<number>(resolve => { resolvePid = resolve })
  const pending = processes.run(process.execPath, ['-e', script], {
    timeoutMs, killGraceMs: 150,
    onSpawn: child => {
      let output = ''
      child.stdout.on('data', chunk => { output += String(chunk); const match = /leaf:(\d+)/.exec(output); if (match) resolvePid(Number(match[1])) })
    },
  })
  // If launch fails, fail promptly instead of waiting for an absent handshake.
  const pid = await Promise.race([pidReady, pending.then(() => { throw Error('fixture exited before PID handshake') })])
  return { pid, pending }
}

async function expectGone(pid: number) {
  const { scenarioProcessSnapshot } = await import('./cli-scenario-process.js')
  const row = scenarioProcessSnapshot().find(row => row.pid === pid)
  expect(!row || row.zombie).toBe(true)
}

for (const detached of [false, true]) {
  it(`reaps a real ${detached ? 'detached' : 'same-group'} grandchild with ignored stdio`, async () => {
    const { pid, pending } = await startFixture(grandchildFixture(detached))
    await new Promise(resolve => setTimeout(resolve, 150))
    const rejected = expect(pending).rejects.toThrow('CLI_SCENARIO_CLEANUP')
    await Promise.all([processes.dispose(), processes.dispose()])
    await rejected
    await expectGone(pid)
  }, 15_000)
}

it('retains observed detached descendants after their leader exits', async () => {
  const { pid, pending } = await startFixture(grandchildFixture(true, true))
  await expect(pending).rejects.toThrow('CLI_DESCENDANTS_REMAINED')
  await expectGone(pid)
}, 15_000)

it.skipIf(process.platform === 'win32')('collects a late detached child created by a TERM handler', async () => {
  const leaf = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
  const script = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{const c=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'});console.log('leaf:'+c.pid)});console.log('ready');setInterval(()=>{},1000)`
  let resolveReady!: () => void, resolvePid!: (pid: number) => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  const pidReady = new Promise<number>(resolve => { resolvePid = resolve })
  const pending = processes.run(process.execPath, ['-e', script], {
    timeoutMs: 5_000, killGraceMs: 200,
    onSpawn: child => { child.stdout.on('data', chunk => { const text = String(chunk); if (text.includes('ready')) resolveReady(); const match = /leaf:(\d+)/.exec(text); if (match) resolvePid(Number(match[1])) }) },
  })
  await ready
  const rejected = expect(pending).rejects.toThrow('CLI_SCENARIO_CLEANUP')
  await processes.dispose()
  await rejected
  await expectGone(await pidReady)
}, 15_000)

it('does not equate a recycled PID or absent process with the captured identity', async () => {
  const { sameScenarioProcess } = await import('./cli-scenario-process.js')
  const captured = { pid: 123, ppid: 1, birth: '100:123', zombie: false }
  expect(sameScenarioProcess(captured, { ...captured, birth: '100:124' })).toBe(false)
  expect(sameScenarioProcess(captured, undefined)).toBe(false)
  expect(sameScenarioProcess(captured, { ...captured, ppid: 2 })).toBe(true)
})

it('refuses to signal a real live PID with a mismatched birth identity', async () => {
  const { scenarioProcessSnapshot, signalScenarioProcess } = await import('./cli-scenario-process.js')
  let pid = 0
  const pending = processes.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 5_000, onSpawn: child => { pid = child.pid! },
  })
  const captured = scenarioProcessSnapshot().find(row => row.pid === pid)!
  expect(captured).toBeDefined()
  signalScenarioProcess({ ...captured, birth: captured.birth + '-different' }, 'SIGKILL')
  expect(() => signalScenarioProcess(captured, 'SIGKILL', () => [])).toThrow('CLI_PROCESS_IDENTITY_UNREADABLE')
  expect(() => process.kill(pid, 0)).not.toThrow()
  const rejected = expect(pending).rejects.toThrow('CLI_SCENARIO_CLEANUP')
  await processes.dispose()
  await rejected
  await expectGone(pid)
})

it('keeps cleanup failed when a real owned PID becomes unreadable', async () => {
  const { scenarioProcessSnapshot } = await import('./cli-scenario-process.js')
  let omit = false, pid = 0
  const owner = new ScenarioProcesses(() => scenarioProcessSnapshot().filter(row => !omit || row.pid !== pid))
  const pending = owner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 5_000, killGraceMs: 100, onSpawn: child => { pid = child.pid! },
  })
  omit = true
  const rejected = expect(pending).rejects.toThrow('CLI_PROCESS_IDENTITY_UNREADABLE')
  await expect(owner.dispose()).rejects.toThrow('CLI_SCENARIO_CLEANUP_INCOMPLETE')
  await rejected
  expect(owner.activeCount).toBe(1)
  // Discovery failed, but the known root handle still gets emergency cleanup.
  await new Promise(resolve => setTimeout(resolve, 100))
  await expectGone(pid)
})

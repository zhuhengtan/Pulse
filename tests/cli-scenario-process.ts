import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ScenarioProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  elapsedMs: number
  firstOutputMs?: number | undefined
}

export interface ScenarioProcessIdentity { pid: number; ppid: number; birth: string; zombie: boolean }
export function sameScenarioProcess(a: ScenarioProcessIdentity, b: ScenarioProcessIdentity | undefined): boolean {
  return b !== undefined && a.birth !== '' && a.pid === b.pid && a.birth === b.birth
}

// Use native birth identities, not ps lstart (only second precision). Absolute
// system-tool paths deliberately do not inherit the CLI fixture's pruned PATH.
export function scenarioProcessSnapshot(): ScenarioProcessIdentity[] {
  if (process.platform === 'linux') {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        return [{ pid: Number(name), ppid: Number(fields[1]), birth: fields[19]!, zombie: fields[0] === 'Z' }]
      } catch (error) {
        if (['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return []
        throw error
      }
    })
  }
  const windows = process.platform === 'win32'
  if (!windows && process.platform !== 'darwin') throw Error('CLI_PROCESS_SNAPSHOT_UNSUPPORTED')
  const tool = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/usr/bin/python3'
  const script = windows
    ? 'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { @{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;birth=$_.CreationDate.ToUniversalTime().Ticks.ToString();zombie=$false} })'
    : `import ctypes,json,struct
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
size=lib.proc_listallpids(None,0)+256
pids=(ctypes.c_int*size)()
count=lib.proc_listallpids(pids,ctypes.sizeof(pids))
if count<=0: raise RuntimeError('proc_listallpids failed')
rows=[]
for pid in pids[:count]:
 b=ctypes.create_string_buffer(136)
 if lib.proc_pidinfo(pid,3,0,b,136)==136:
  status=struct.unpack_from('I',b.raw,4)[0]
  ppid=struct.unpack_from('I',b.raw,16)[0]
  sec,usec=struct.unpack_from('QQ',b.raw,120)
  rows.append(dict(pid=pid,ppid=ppid,birth=str(sec)+':'+str(usec),zombie=status==5))
print(json.dumps(rows))`
  const result = spawnSync(tool, windows ? ['-NoProfile', '-NonInteractive', '-Command', script] : ['-c', script], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw Error(`CLI_PROCESS_SNAPSHOT_FAILED: ${result.error?.message ?? result.stderr}`)
  return JSON.parse(result.stdout) as ScenarioProcessIdentity[]
}

function processStillExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw Error(`CLI_PROCESS_IDENTITY_UNREADABLE: pid=${pid}; ${String(error)}`)
  }
}

function requireAbsentProcessExited(pid: number): void {
  if (processStillExists(pid)) throw Error(`CLI_PROCESS_IDENTITY_UNREADABLE: pid=${pid}; process still exists`)
}

export function signalScenarioProcess(row: ScenarioProcessIdentity, requested: NodeJS.Signals,
  snapshot: () => ScenarioProcessIdentity[] = scenarioProcessSnapshot): void {
  // Re-read immediately before each signal, including previously reparented
  // descendants. A PID identity mismatch never grants kill permission.
  const current = new Map(snapshot().map(item => [item.pid, item]))
  if (!current.has(row.pid)) requireAbsentProcessExited(row.pid)
  if (!sameScenarioProcess(row, current.get(row.pid)) || current.get(row.pid)!.zombie) return
  if (process.platform === 'win32') {
    const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(row.pid), '/T', '/F'], { encoding: 'utf8', timeout: 3_000 })
    if (result.error || result.status !== 0) {
      if (sameScenarioProcess(row, new Map(snapshot().map(item => [item.pid, item])).get(row.pid))) throw Error(`CLI_TREE_KILL_FAILED: ${result.error?.message ?? result.stderr}`)
    }
  } else {
    try { process.kill(row.pid, requested) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// Fixture-scoped ownership, including observed detached descendants. This is
// not a kernel job/container: a process born and reparented entirely between
// snapshots cannot be discovered. Never infer ownership from a recycled PID.
export class ScenarioProcesses {
  private readonly active = new Set<{ stop: (reason: string) => void; done: Promise<ScenarioProcessResult> }>()
  private disposed = false

  constructor(private readonly snapshot: () => ScenarioProcessIdentity[] = scenarioProcessSnapshot) {}

  run(command: string, args: string[], options: {
    cwd?: string | undefined
    env?: NodeJS.ProcessEnv | undefined
    input?: string | undefined
    timeoutMs: number
    killGraceMs?: number
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void
    onClose?: (result: ScenarioProcessResult) => void
  }): Promise<ScenarioProcessResult> {
    if (this.disposed) return Promise.reject(new Error('CLI_SCENARIO_DISPOSED'))
    const started = performance.now()
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', firstOutputMs: number | undefined
    let failure: Error | undefined
    let closed = false, exited = false
    let code: number | null = null, signal: NodeJS.Signals | null = null
    let finishing: Promise<void> | undefined
    const owned = new Map<number, ScenarioProcessIdentity>()
    let root: ScenarioProcessIdentity | undefined
    let cleanupDeadline = Infinity
    const checkCleanupBudget = () => {
      if (performance.now() >= cleanupDeadline) throw Error('CLI_TREE_CLEANUP_BUDGET')
    }
    const collect = () => {
      checkCleanupBudget()
      const snapshot = this.snapshot()
      checkCleanupBudget()
      const current = new Map(snapshot.map(row => [row.pid, row]))
      // Global enumeration may omit inaccessible rows. An owned PID missing
      // from metadata is only gone if the OS confirms ESRCH; EPERM is unknown.
      const retainUnknown = (pid: number) => {
        if (!current.has(pid) && processStillExists(pid)) {
          // macOS may temporarily omit an exiting, not-yet-reaped child.
          // Unknown stays live for cleanup accounting, but is never signalled.
          current.set(pid, { pid, ppid: 0, birth: '', zombie: false })
        }
      }
      for (const pid of owned.keys()) retainUnknown(pid)
      // Only the actual live ChildProcess may establish the initial root.
      if (!root && !exited && child.pid) {
        retainUnknown(child.pid)
        const candidate = current.get(child.pid)
        if (candidate) {
          owned.set(candidate.pid, candidate)
          if (candidate.birth) root = candidate
        }
      }
      let changed = true
      while (changed) {
        changed = false
        for (const row of snapshot) {
          const parent = owned.get(row.ppid)
          if (!owned.has(row.pid) && parent && sameScenarioProcess(parent, current.get(parent.pid))) {
            owned.set(row.pid, row); changed = true
          }
        }
      }
      return current
    }
    const live = (current: Map<number, ScenarioProcessIdentity>) => [...owned.values()].filter(row => (sameScenarioProcess(row, current.get(row.pid)) || current.get(row.pid)?.birth === '') && !current.get(row.pid)!.zombie)
    const send = (row: ScenarioProcessIdentity, requested: NodeJS.Signals) => signalScenarioProcess(row, requested, () => [...collect().values()])
    let resolveDone!: (result: ScenarioProcessResult) => void, rejectDone!: (error: Error) => void
    const done = new Promise<ScenarioProcessResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    const record = { stop: (reason: string) => { failure ??= Error(`${reason}: ${command} ${args[0] ?? ''}`); finish() }, done }
    const finish = () => {
      if (finishing) return
      clearTimeout(deadline); clearInterval(poll)
      // A total discovery/signal budget also bounds large trees. Synchronous
      // native calls may overshoot it by their own bounded 3s timeout; Windows
      // taskkill failure verification adds at most one such snapshot. This is
      // not a claim that the grace + reap polling windows bound total cleanup.
      cleanupDeadline = performance.now() + (process.platform === 'win32' ? 8_000 : 5_000)
      finishing = (async () => {
        try {
          let current = collect()
          if (!failure && live(current).some(row => row.pid !== child.pid)) failure = Error('CLI_DESCENDANTS_REMAINED')
          // On Windows kill the still-owned root tree first. On POSIX retain
          // parentage while terminating descendants, then the root.
          const targets = live(current)
          if (process.platform !== 'win32') targets.reverse()
          for (const row of targets) send(row, 'SIGTERM')
          // Spawn failures have no PID and still emit close. Root may have
          // already exited before the first snapshot; never signal a guess.
          const graceEnd = performance.now() + (options.killGraceMs ?? 500)
          while (performance.now() < graceEnd && (live(current).length || !closed)) {
            await delay(25); current = collect()
          }
          const reapEnd = performance.now() + 2_000
          do {
            current = collect()
            for (const row of live(current).reverse()) send(row, 'SIGKILL')
            if (closed && live(collect()).length === 0) break
            await delay(25)
          } while (performance.now() < reapEnd)
          current = collect()
          if (live(current).some(row => current.get(row.pid)?.birth === '')) throw Error('CLI_PROCESS_IDENTITY_UNREADABLE: cleanup deadline')
          if (!closed || live(current).length) throw Error(`CLI_CHILD_REAP_DEADLINE: pid=${child.pid}; live=${live(current).map(row => row.pid).join(',')}`)
          this.active.delete(record)
          const result = { code, signal, stdout, stderr, elapsedMs: Math.round(performance.now() - started), firstOutputMs: firstOutputMs === undefined ? undefined : Math.round(firstOutputMs) }
          options.onClose?.(result)
          if (failure) rejectDone(Error(`${failure.message}; elapsed=${result.elapsedMs}ms; code=${code}; signal=${signal}; stdout=${stdout.slice(-1000)}; stderr=${stderr.slice(-1000)}`))
          else resolveDone(result)
        } catch (error) {
          // Metadata failure must remain a failure, but do not abandon the
          // actual child handle just because descendant discovery failed.
          if (!exited && child.pid) {
            try { child.kill('SIGTERM') } catch { /* preserve the discovery error */ }
            await delay(options.killGraceMs ?? 500)
            if (!exited) { try { child.kill('SIGKILL') } catch { /* preserve the discovery error */ } }
          }
          rejectDone(Error(`${failure?.message ?? 'CLI_CLEANUP_FAILED'}; ${String(error)}`))
        }
      })()
    }
    child.stdout.on('data', chunk => { firstOutputMs ??= performance.now() - started; stdout += chunk.toString() })
    child.stderr.on('data', chunk => { firstOutputMs ??= performance.now() - started; stderr += chunk.toString() })
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') record.stop(`CLI_STDIN_ERROR: ${error.message}`) })
    child.on('error', error => { failure ??= error })
    child.once('exit', (value, received) => { exited = true; code = value; signal = received; finish() })
    child.once('close', (value, received) => { closed = true; code = value; signal = received; finish() })
    const deadline = setTimeout(() => record.stop(`CLI_CHILD_DEADLINE ${options.timeoutMs}ms`), options.timeoutMs)
    const poll = setInterval(() => { try { collect() } catch (error) { record.stop(String(error)) } }, process.platform === 'win32' ? 250 : 50)
    this.active.add(record)
    void done.catch(() => undefined)
    try { collect(); child.stdin.end(options.input); options.onSpawn?.(child) } catch (error) { record.stop(`CLI_SETUP_FAILED: ${String(error)}`) }
    return done
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const pending = [...this.active]
    for (const child of pending) child.stop('CLI_SCENARIO_CLEANUP')
    await Promise.allSettled(pending.map(child => child.done))
    if (this.active.size) throw Error('CLI_SCENARIO_CLEANUP_INCOMPLETE')
  }

  get activeCount(): number { return this.active.size }
}

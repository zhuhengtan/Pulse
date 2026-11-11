import { spawn } from 'node:child_process'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { decodeUtf8WithinByteLimit, resolveShellIdentity, type runShell, type ShellResult } from '../../packages/adapters/src/tools/shell.js'

const denied = () => new Error('FIXTURE_NODE_CHECK_NOT_ALLOWED')
export function assertFixtureCleanupExit(code: number | null): void {
  if (code !== 0) throw new Error('FIXTURE_NODE_CHECK_CLEANUP_FAILED')
}

/** Ledger tests need real check output, not another native ACL lifecycle per
 * identity. This is test-only: only caller-owned, exact fixture bytes and argv
 * may execute. Native Host/sandbox integration remains in the native suites. */
export async function fixtureNodeChecks(directory: string, argv: readonly (readonly string[])[], files: Record<string, readonly string[]>) {
  const root = await realpath(directory), node = await realpath(process.execPath), rootStamp = await stat(root)
  const allowed = new Set(argv.map(args => JSON.stringify(args)))
  const definitions = Object.entries(files).map(([name, contents]) => {
    if (name !== basename(name) || !/^[a-zA-Z0-9][a-zA-Z0-9._ -]*\.mjs$/.test(name) || !contents.length) throw denied()
    return { name, contents: [...contents] }
  })
  for (const args of argv) {
    // Only explicit owned files, never shell text, globs or arbitrary Node flags.
    const names = args.length === 1 ? args : args[0] === '--test'
      ? args.length === 3 && args[1]!.startsWith('--test-name-pattern=') ? args.slice(2) : args.slice(1)
      : []
    if (!names.length || names.some(name => !Object.hasOwn(files, name))) throw denied()
  }
  const calls: Array<{ args: string[]; pid: number | undefined; result?: ShellResult }> = []
  const validate = async () => {
    const current = await stat(root)
    if (await realpath(root) !== root || current.dev !== rootStamp.dev || current.ino !== rootStamp.ino) throw denied()
    for (const { name, contents } of definitions) {
      const path = join(root, name)
      if (!(await lstat(path)).isFile() || await realpath(path) !== path || !contents.includes(await readFile(path, 'utf8'))) throw denied()
    }
  }
  const execute: typeof runShell = async (command, args = [], options = {}) => {
    const invocation = [...args]
    const expected = options.expectedIdentity && { ...options.expectedIdentity, prefixArgs: [...options.expectedIdentity.prefixArgs] }
    if (command !== 'node' || !allowed.has(JSON.stringify(invocation)) || !options.cwd || await realpath(options.cwd) !== root
      || !options.workspaceRoot || await realpath(options.workspaceRoot) !== root || options.spawnProcess || options.stdinData !== undefined
      || options.windowsPty || options.stdioTarget || options.allowedDomains?.length || options.allowLoopback) throw denied()
    const limit = options.maxOutputBytes ?? 64 * 1024, timeout = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(timeout) || timeout < 1) throw denied()
    await validate()
    const matches = (actual: Awaited<ReturnType<typeof resolveShellIdentity>>, identity: typeof expected) => !identity
      || actual.fingerprint === identity.fingerprint && actual.executable === identity.executable && JSON.stringify(actual.prefixArgs) === JSON.stringify(identity.prefixArgs)
    const initial = await resolveShellIdentity(command, invocation, root, options.env)
    if (!matches(initial, expected)) throw denied()
    const identity = options.beforeLaunch ? await options.beforeLaunch() : expected
    const current = await resolveShellIdentity(command, invocation, root, options.env)
    if (JSON.stringify(args) !== JSON.stringify(invocation) || current.executable !== node || current.prefixArgs.length
      || !matches(current, expected) || !matches(current, identity)) throw denied()
    await validate()
    const result = (code: number | null, stdout = '', stderr = '', stopped?: string): ShellResult => ({
      code, stdout, stderr, truncated: stopped === 'output', timedOut: stopped === 'timeout', aborted: stopped === 'abort',
    })
    if (options.signal?.aborted) return result(null, '', '', 'abort')
    // Do not give these fixed scripts inherited provider credentials or startup
    // configuration. Keep the ordinary test network guard in Node children.
    const source = options.env ?? process.env
    const env = Object.fromEntries(Object.entries(source).filter(([key]) => /^(PATH|HOME|USERPROFILE|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|LANG|LC_ALL)$/i.test(key)))
    if (process.env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS
    return new Promise<ShellResult>((resolve, reject) => {
      const child = spawn(node, invocation, { cwd: root, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      const call: typeof calls[number] = { args: [...invocation], pid: child.pid }; calls.push(call)
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }, sizes = { stdout: 0, stderr: 0 }
      let stopped: string | undefined, failure: Error | undefined, closed = false, termination: Promise<void> | undefined
      const stop = (reason: string) => {
        if (closed) return
        stopped ??= reason
        if (termination || child.pid === undefined) return
        const pid = child.pid
        termination = (async () => {
          if (process.platform === 'win32') {
            const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
            if (!systemRoot) throw new Error('FIXTURE_NODE_CHECK_CLEANUP_UNAVAILABLE')
            await new Promise<void>((done, fail) => {
              const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
              killer.once('error', fail)
              killer.once('close', code => { try { assertFixtureCleanupExit(code); done() } catch (error) { fail(error) } })
            })
          } else {
            try { process.kill(-pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
          }
        })().catch(error => { failure = error; child.kill('SIGKILL') })
      }
      const abort = () => stop('abort')
      options.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => stop('timeout'), timeout)
      for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => {
        const remaining = Math.max(0, limit - sizes[stream])
        chunks[stream].push(chunk.subarray(0, remaining)); sizes[stream] += chunk.length
        if (sizes[stream] > limit) stop('output')
        try { options.onOutput?.(stream, chunk.subarray(0, remaining)) } catch (error) { failure = error as Error; stop('observer') }
      })
      child.once('error', error => { failure = error })
      child.once('close', (code, signal) => {
        closed = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
        void (async () => {
          await termination
          if (failure) throw failure
          if (signal && !stopped) throw new Error('FIXTURE_NODE_CHECK_UNEXPECTED_SIGNAL')
          const output = result(stopped ? null : code, decodeUtf8WithinByteLimit(Buffer.concat(chunks.stdout), limit), decodeUtf8WithinByteLimit(Buffer.concat(chunks.stderr), limit), stopped)
          call.result = output; options.onProcessResult?.(output); resolve(output)
        })().catch(reject)
      })
      if (options.signal?.aborted) abort()
    })
  }
  return { execute, calls }
}

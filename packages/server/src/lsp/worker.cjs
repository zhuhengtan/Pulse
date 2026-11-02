'use strict'
// Fixed host-owned sidecar: its own SandboxManager lease cannot block normal tools.
// Keep the trusted helper HOME for read-deny computation. Only the target's HOME
// is replaced by runShell. No user config/provider module is loaded here.
async function main() {
  const { spawn } = require('node:child_process')
  const { runShell } = await import('@hunterzhu/pulse-adapters')
  const spec = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  process.stdin.once('end', () => controller.abort())
  let input
  const buffered = []; let bytes = 0
  process.stdin.on('data', chunk => {
    if (input) input.write(chunk)
    else { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) controller.abort(); else buffered.push(chunk) }
  })
  const result = await runShell(spec.command, spec.args, {
    cwd: spec.root, signal: controller.signal, timeoutMs: 0, maxOutputBytes: 1024,
    allowedDomains: [], readOnlyWorkspace: true, isolatedHome: true, stdioTarget: true,
    readRoots: spec.readRoots, expectedIdentity: spec.identity,
    spawnProcess(argv, options) {
      controller.signal.throwIfAborted()
      const child = spawn(argv[0], argv.slice(1), { ...options, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' })
      input = child.stdin
      input.on('error', () => controller.abort())
      for (const chunk of buffered.splice(0)) input.write(chunk)
      child.stdout.on('data', chunk => process.stdout.write(chunk))
      // Flush complete frames, then propagate EOF without waiting for ACL cleanup.
      child.stdout.once('end', () => process.stdout.end())
      // Protocol output never passes through a text/line converter.
      return { pid: child.pid, get exitCode() { return child.exitCode }, get signalCode() { return child.signalCode }, stdin: null, stdout: null, stderr: child.stderr, once: child.once.bind(child), kill: child.kill.bind(child) }
    },
  })
  process.exitCode = result.aborted ? 0 : result.code === 0 ? 0 : 1
  process.stdin.pause()
}
main().catch(() => { process.stderr.write('LSP_SERVER_UNAVAILABLE\n'); process.exitCode = 1; process.stdin.pause() })

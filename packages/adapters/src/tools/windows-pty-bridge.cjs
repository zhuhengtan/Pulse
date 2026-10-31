'use strict'

const { encodeFrame, createParser, isWindowsExitCode } = require('./windows-pty-protocol.cjs')

// Executed ONLY inside the existing Windows SRT restricted token and Job. The
// host's pipe carries framed UTF-8 input; the actual target sees a ConPTY.
// Acknowledgements travel on this process's stderr, which the target does not
// inherit. No shell, provider, configuration file or network connection is opened.
function confirmPtyWrite(terminal, data, done) {
  const socket = terminal && terminal._agent && terminal._agent.inSocket
  if (!socket || typeof socket.write !== 'function') {
    try { terminal.write(data); done(null) } catch (error) { done(error) }
    return
  }
  const original = socket.write
  let settled = false
  const finish = (error) => { if (!settled) { settled = true; if (socket.write !== original) socket.write = original; done(error || null) } }
  socket.write = function (chunk, encoding, callback) {
    socket.write = original
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined }
    return original.call(socket, chunk, encoding, (error) => {
      if (typeof callback === 'function') callback(error)
      finish(error)
    })
  }
  try { terminal.write(data) } catch (error) { finish(error) }
}

function startWindowsPty(spec, pty, io = process) {
  const env = { ...io.env }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key]
  const terminal = pty.spawn(spec.command, spec.args, {
    cwd: io.cwd(), env, name: 'xterm-256color', cols: 100, rows: 30,
    useConpty: true, useConptyDll: false, conptyInheritCursor: false,
  })
  let exited = false
  const send = (message) => { if (io.stderr && typeof io.stderr.write === 'function') io.stderr.write(encodeFrame({ ...message, scope: spec.scope })) }
  send({ type: 'ready' })
  const parser = createParser((message) => {
    if (message.scope !== spec.scope || message.type !== 'input' || typeof message.data !== 'string' || exited) return
    confirmPtyWrite(terminal, message.data, (error) => { if (!exited) send({ type: error ? 'nack' : 'ack', id: message.id }) })
  })
  const input = (chunk) => parser(chunk)
  const stop = () => { if (!exited) terminal.kill() }
  io.stdin.on('data', input)
  io.stdin.once('end', stop)
  io.stdin.once('error', stop)
  terminal.onData(data => io.stdout.write(data))
  terminal.onExit(({ exitCode }) => {
    exited = true
    io.stdin.removeListener('data', input)
    io.stdin.removeListener('end', stop)
    io.stdin.removeListener('error', stop)
    io.stdin.pause()
    const valid = isWindowsExitCode(exitCode)
    // Drain the last output before exiting; process.exit() could lose it.
    io.stdout.end(() => {
      const frame = encodeFrame(valid ? { type: 'exit', scope: spec.scope, code: exitCode } : { type: 'exitUnknown', scope: spec.scope })
      const finish = () => io.exit(valid ? exitCode : 1)
      if (io.stderr && typeof io.stderr.write === 'function') io.stderr.write(frame, finish)
      else finish()
    })
  })
  return terminal
}

module.exports = { startWindowsPty, confirmPtyWrite }
if (require.main === module) {
  try {
    if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
    const spec = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
    if (typeof spec.modulePath !== 'string' || typeof spec.command !== 'string' || typeof spec.scope !== 'string' || !/^[0-9a-f]{32}$/.test(spec.scope) || !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string')) throw new Error('INVALID_PTY_SPEC')
    startWindowsPty(spec, require(spec.modulePath))
  } catch {
    process.stderr.write('AGENT_PTY_UNAVAILABLE\n')
    process.exitCode = 1
  }
}

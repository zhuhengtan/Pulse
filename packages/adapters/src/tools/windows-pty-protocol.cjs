'use strict'

// Private host↔bridge frames. Target ConPTY output is not on this channel, and
// every frame must echo the per-launch scope the target never receives.
const MAGIC = Buffer.from('PTY1')
const HEADER = 42
const TYPES = { ready: 1, input: 2, ack: 3, nack: 4, exit: 5, exitUnknown: 6 }
const NAMES = Object.fromEntries(Object.entries(TYPES).map(([name, code]) => [code, name]))

// node-pty reports GetExitCodeProcess through a signed int. 300 and a
// high-bit NTSTATUS are known failures; only a non-integer is unknown.
function isWindowsExitCode(code) {
  return typeof code === 'number' && Number.isInteger(code) && code >= -0x80000000 && code <= 0x7fffffff
}

function encodeFrame(message) {
  const scope = Buffer.from(String(message.scope), 'hex')
  const id = message.id ? Buffer.from(String(message.id), 'hex') : Buffer.alloc(16)
  if (scope.length !== 16 || id.length !== 16 || !TYPES[message.type]) throw new Error('INVALID_PTY_FRAME')
  let payload = Buffer.alloc(0)
  if (message.data !== undefined) payload = Buffer.from(message.data, 'utf8')
  else if (message.type === 'exit') {
    if (!isWindowsExitCode(message.code)) throw new Error('INVALID_PTY_FRAME')
    payload = Buffer.alloc(4)
    payload.writeInt32BE(message.code)
  }
  if (payload.length > 16_384) throw new Error('INVALID_PTY_FRAME')
  const frame = Buffer.alloc(HEADER + payload.length)
  MAGIC.copy(frame, 0)
  frame[4] = 1
  frame[5] = TYPES[message.type]
  scope.copy(frame, 6)
  id.copy(frame, 22)
  frame.writeUInt32BE(payload.length, 38)
  payload.copy(frame, HEADER)
  return frame
}

function parseFrame(frame) {
  const type = NAMES[frame[5]]
  const payload = frame.subarray(HEADER)
  return {
    type,
    scope: frame.subarray(6, 22).toString('hex'),
    id: frame.subarray(22, 38).toString('hex'),
    ...(type === 'input' ? { data: payload.toString('utf8') } : {}),
    ...(type === 'exit' && payload.length === 4 ? { code: payload.readInt32BE(0) } : {}),
  }
}

function createParser(onFrame) {
  let buffer = Buffer.alloc(0)
  return function push(chunk) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    const plain = []
    while (buffer.length > 0) {
      const magicAt = buffer.indexOf(MAGIC)
      if (magicAt < 0) {
        // A chunk may end on PT/PTY. Dropping that prefix makes the next chunk
        // unable to see PTY1, so ready and ack never arrive.
        let keep = 0
        const limit = Math.min(MAGIC.length - 1, buffer.length)
        for (let size = limit; size > 0; size--) {
          if (buffer.subarray(buffer.length - size).equals(MAGIC.subarray(0, size))) { keep = size; break }
        }
        if (keep < buffer.length) plain.push(buffer.subarray(0, buffer.length - keep))
        buffer = keep === 0 ? Buffer.alloc(0) : buffer.subarray(buffer.length - keep)
        break
      }
      if (magicAt > 0) { plain.push(buffer.subarray(0, magicAt)); buffer = buffer.subarray(magicAt) }
      if (buffer.length < HEADER) break
      const length = buffer.readUInt32BE(38)
      if (length > 16_384 || buffer[4] !== 1 || !NAMES[buffer[5]]) { plain.push(buffer.subarray(0, 4)); buffer = buffer.subarray(4); continue }
      if (buffer.length < HEADER + length) break
      const frame = buffer.subarray(0, HEADER + length)
      buffer = buffer.subarray(HEADER + length)
      onFrame(parseFrame(frame))
    }
    return plain.length ? Buffer.concat(plain) : Buffer.alloc(0)
  }
}

module.exports = { encodeFrame, createParser, isWindowsExitCode }

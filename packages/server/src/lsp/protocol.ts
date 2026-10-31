/** LSP byte framing. Limits apply before allocation/JSON parsing. */
export class LspFrames {
  private buffer: Buffer = Buffer.alloc(0)
  constructor(private readonly consume: (value: any) => void) {}
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > 2 * 1024 * 1024 + 8192) throw new Error('LSP_FRAME_TOO_LARGE')
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) { if (this.buffer.length > 8192) throw new Error('LSP_HEADER_TOO_LARGE'); return }
      if (end > 8192) throw new Error('LSP_HEADER_TOO_LARGE')
      const header = this.buffer.subarray(0, end).toString('ascii')
      const lengths = header.split('\r\n').filter(line => /^Content-Length:/i.test(line))
      if (lengths.length !== 1 || !/^Content-Length:\s*[0-9]+\s*$/i.test(lengths[0]!)) throw new Error('LSP_HEADER_INVALID')
      const bytes = Number(lengths[0]!.split(':')[1])
      if (!Number.isSafeInteger(bytes) || bytes < 2 || bytes > 2 * 1024 * 1024) throw new Error('LSP_FRAME_TOO_LARGE')
      if (this.buffer.length < end + 4 + bytes) return
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(end + 4, end + 4 + bytes))
      this.buffer = this.buffer.subarray(end + 4 + bytes)
      const value = JSON.parse(text)
      if (!value || value.jsonrpc !== '2.0') throw new Error('LSP_MESSAGE_INVALID')
      this.consume(value)
    }
  }
}
export function lspFrame(value: unknown): Buffer { const body = Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]) }

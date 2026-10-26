import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { redactJarvisText } from './jarvis/privacy.js'
const limit = 64 * 1024, maxLine = 8 * 1024
const logName = /^desktop-(?:launcher|service-\d+)\.log(?:\.1)?$/
/** Local metadata/error logs only: bounded, redacted before bytes ever reach disk. */
export class LocalDiagnosticLog {
  readonly path: string
  constructor(readonly directory: string, name = `desktop-service-${process.pid}.log`, private maxBytes = limit) {
    if (!logName.test(name) || name.endsWith('.1')) throw new Error('DIAGNOSTIC_LOG_NAME_INVALID')
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.path = join(directory, name)
  }
  record(event: string, detail: unknown): void {
    try {
      let raw = typeof detail === 'string' ? detail : JSON.stringify(detail) ?? ''
      if (Buffer.byteLength(raw) > maxLine || /-----BEGIN [^-]*PRIVATE KEY-----/.test(raw)) raw = '[output omitted]'
      const safe = redactJarvisText(raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))
      const line = JSON.stringify({ at: new Date().toISOString(), event: redactJarvisText(event).slice(0, 60), detail: safe }) + '\n'
      if ((existsSync(this.path) ? statSync(this.path).size : 0) + Buffer.byteLength(line) > this.maxBytes) {
        try { unlinkSync(this.path + '.1') } catch {}
        try { renameSync(this.path, this.path + '.1') } catch {}
      }
      appendFileSync(this.path, line, { mode: 0o600 })
      const files = readdirSync(this.directory).filter(name => logName.test(name)).map(name => ({ name, at: statSync(join(this.directory, name)).mtimeMs })).sort((a,b) => b.at-a.at)
      for (const file of files.slice(8)) try { unlinkSync(join(this.directory, file.name)) } catch {}
    } catch { /* Diagnostics must never prevent startup or terminate a running task. */ }
  }
}
export class DiagnosticLines {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private omitted = false
  private privateKey = false
  constructor(private log: LocalDiagnosticLog, private channel: string) {}
  write(chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk))
    for (const piece of text.split(/(?<=\n)/)) {
      if (!this.omitted) this.pending += piece
      if (Buffer.byteLength(this.pending) > maxLine) { this.pending = ''; this.omitted = true }
      if (piece.endsWith('\n')) this.flush()
    }
  }
  flush(): void {
    if (this.omitted) this.log.record(this.channel, '[oversized output omitted]')
    else if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(this.pending)) { this.privateKey = true; this.log.record(this.channel, '[private key omitted]') }
    else if (!this.privateKey && this.pending.trim()) this.log.record(this.channel, this.pending.trimEnd())
    if (/-----END [^-]*PRIVATE KEY-----/.test(this.pending)) this.privateKey = false
    this.pending = ''; this.omitted = false
  }
}
let installed = false
export function installProcessDiagnostics(directory: string): void {
  if (installed) return
  const log = new LocalDiagnosticLog(directory), stdout = new DiagnosticLines(log, 'stdout'), stderr = new DiagnosticLines(log, 'stderr')
  installed = true
  log.record('process-start', { pid: process.pid, node: process.versions.node })
  for (const [stream, capture] of [[process.stdout, stdout], [process.stderr, stderr]] as const) {
    const original = stream.write.bind(stream)
    stream.write = ((...args: Parameters<typeof stream.write>) => { try { capture.write(typeof args[0] === 'string' ? args[0] : args[0] as Uint8Array) } catch { /* Preserve the original stream on diagnostic failure. */ } return original(...args) }) as typeof stream.write
  }
  process.on('uncaughtExceptionMonitor', error => log.record('uncaught-error', { name: error.name, message: error.message }))
  process.once('exit', code => { stdout.flush(); stderr.flush(); log.record('process-exit', { pid: process.pid, code }) })
}
export function readLocalDiagnostics(directory: string): { directory: string; text: string } {
  try {
    const files = readdirSync(directory).filter(name => logName.test(name)).map(name => ({ name, at: statSync(join(directory,name)).mtimeMs })).sort((a,b)=>b.at-a.at).slice(0,4)
    const text = files.map(file => `--- ${file.name} ---\n${readFileSync(join(directory,file.name),'utf8').slice(-8192)}`).join('\n').slice(-32768)
    return { directory, text: text || '暂无桌面启动日志。外部入口启动的后台请在原入口查看日志。' }
  } catch { return { directory, text: '暂无可读取的桌面启动日志。' } }
}

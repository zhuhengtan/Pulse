import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { ToolError } from '@hunterzhu/pulse-tool-sdk'
import { validateOfficeArchive } from './tools.js'

/** Parse untrusted Office input off the host event loop, with bounded lifetime. */
export async function extractDocxText(data: Buffer, signal: AbortSignal, timeoutMs = 30_000): Promise<string> {
  if (signal.aborted) throw new ToolError('ABORTED', 'ABORTED')
  if (data.length > 20 * 1024 * 1024) throw new ToolError('DOCUMENT_TOO_LARGE', 'DOCUMENT_TOO_LARGE')
  try { validateOfficeArchive(data) }
  catch (error) {
    const code = error instanceof ToolError ? error.code.replaceAll('XLSX', 'DOCX') : 'INVALID_DOCX'
    throw new ToolError(code, code)
  }
  const modulePath = createRequire(import.meta.url).resolve('mammoth')
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      require(workerData.modulePath).extractRawText({ buffer: Buffer.from(workerData.data) })
        .then(result => parentPort.postMessage({ text: result.value }))
        .catch(() => parentPort.postMessage({ error: 'INVALID_DOCX' }));
    `, { eval: true, workerData: { modulePath, data }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    let finished = false
    const finish = (error?: string, text?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      void worker.terminate().then(() => error ? reject(new ToolError(error, error)) : resolve(text ?? ''))
    }
    const abort = () => finish('ABORTED')
    const timer = setTimeout(() => finish('DOCX_PARSE_TIMEOUT'), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    worker.once('message', message => typeof message?.text === 'string' ? finish(undefined, message.text) : finish('INVALID_DOCX'))
    worker.once('error', () => finish('INVALID_DOCX'))
    worker.once('exit', () => { if (!finished) finish('INVALID_DOCX') })
  })
}

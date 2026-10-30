import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { ToolError } from '@hunterzhu/pulse-tool-sdk'
import { docError, readWorkspaceFile } from './workspace-file.js'

export interface PptxReadRequest {
  path: string
  startSlide?: number | undefined
  endSlide?: number | undefined
  offset?: number | undefined
  maxChars: number
}

export interface PptxReadResult {
  path: string
  hash: string
  totalSlides: number
  startSlide: number
  endSlide: number
  nextSlide: number | null
  nextOffset: number | null
  text: string
  truncated: boolean
}

/** Parse untrusted PPTX bytes off the host event loop, with a hard lifetime. */
export function parsePptxInWorker(data: Buffer, request: Omit<PptxReadRequest, 'path'>, signal: AbortSignal, timeoutMs = 30_000): Promise<Omit<PptxReadResult, 'path' | 'hash'>> {
  if (signal.aborted) throw docError('ABORTED')
  const parserPath = createRequire(import.meta.url).resolve('./pptx-parse.cjs')
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      try {
        parentPort.postMessage({ parsed: require(workerData.parserPath).parsePptx(Buffer.from(workerData.data), workerData.request) })
      } catch (error) {
        parentPort.postMessage({ error: error && error.code ? String(error.code) : 'INVALID_PPTX' })
      }
    `, { eval: true, workerData: { parserPath, data, request }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    let finished = false
    const finish = (error?: string, parsed?: Omit<PptxReadResult, 'path' | 'hash'>) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      void worker.terminate().then(() => error ? reject(error === 'ABORTED' ? docError('ABORTED') : new ToolError(error, error)) : resolve(parsed!))
    }
    const abort = () => finish('ABORTED')
    const timer = setTimeout(() => finish('PPTX_PARSE_TIMEOUT'), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    worker.once('message', (message: { parsed?: Omit<PptxReadResult, 'path' | 'hash'>; error?: string }) => message?.parsed ? finish(undefined, message.parsed) : finish(message?.error ?? 'INVALID_PPTX'))
    worker.once('error', () => finish('INVALID_PPTX'))
    worker.once('exit', () => { if (!finished) finish('INVALID_PPTX') })
  })
}

export async function readPptx(root: string, input: PptxReadRequest, signal: AbortSignal): Promise<PptxReadResult> {
  const { data } = await readWorkspaceFile(root, input.path, signal)
  const parsed = await parsePptxInWorker(Buffer.from(data), {
    ...(input.startSlide === undefined ? {} : { startSlide: input.startSlide }),
    ...(input.endSlide === undefined ? {} : { endSlide: input.endSlide }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    maxChars: input.maxChars,
  }, signal)
  if (signal.aborted) throw docError('ABORTED')
  return { path: input.path, hash: createHash('sha256').update(data).digest('hex'), ...parsed }
}

import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createHash } from 'node:crypto'
import { ToolError } from '@hunterzhu/pulse-tool-sdk'
import { docError, MAX_PDF_PAGES, readWorkspaceFile } from './workspace-file.js'
import { assertOfficeOutputPath } from './output-path.js'
import { requireOfficeBinaryWriter } from './binary-writer.js'

const MAX_EDGE = 4_096
const MAX_PIXELS = 8_000_000
const MAX_PNG_BYTES = 16 * 1024 * 1024

export interface PdfRenderRequest {
  sourcePath: string
  page: number
  path: string
  scale?: number | undefined
  dpi?: number | undefined
  expectedHash?: string | null | undefined
}

export interface PdfRenderResult {
  path: string
  hash: string
  bytes: number
  page: number
  width: number
  height: number
  scale: number
}

interface CanvasPair {
  canvas: { width: number; height: number; toBuffer(mime: 'image/png'): Buffer }
  context: CanvasRenderingContext2D
}

interface CanvasFactory {
  create(width: number, height: number): CanvasPair
  destroy(pair: CanvasPair): void
}

function localPdfAsset(kind: 'standard_fonts' | 'cmaps'): string {
  const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  return join(pdfjsRoot, kind) + sep
}

/** Render one PDF page to a real PNG through the host binary writer. */
export async function renderPdfPage(root: string, input: PdfRenderRequest, signal: AbortSignal): Promise<PdfRenderResult> {
  if (signal.aborted) throw docError('ABORTED')
  if (input.scale !== undefined && input.dpi !== undefined) throw docError('PDF_SCALE_AND_DPI')
  if (input.scale !== undefined && !(input.scale > 0 && input.scale <= 4)) throw docError('PDF_SCALE_OUT_OF_RANGE')
  if (input.dpi !== undefined && (!Number.isInteger(input.dpi) || input.dpi < 36 || input.dpi > 300)) throw docError('PDF_DPI_OUT_OF_RANGE')
  assertOfficeOutputPath('png', input.path)
  const scale = input.dpi !== undefined ? input.dpi / 72 : input.scale ?? 1
  const { data } = await readWorkspaceFile(root, input.sourcePath, signal)
  const loading = getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    stopAtErrors: true,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    standardFontDataUrl: localPdfAsset('standard_fonts'),
    cMapUrl: localPdfAsset('cmaps'),
    cMapPacked: true,
    verbosity: 0,
  })
  let pdf: Awaited<typeof loading.promise> | undefined
  let page: Awaited<ReturnType<Awaited<typeof loading.promise>['getPage']>> | undefined
  let pair: CanvasPair | undefined
  const abort = () => { void loading.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw docError('ABORTED')
    pdf = await loading.promise
    if (signal.aborted) throw docError('ABORTED')
    if (pdf.numPages > MAX_PDF_PAGES) throw docError('PDF_PAGE_COUNT_TOO_LARGE')
    if (input.page < 1 || input.page > pdf.numPages) throw docError('INVALID_PDF_PAGE_RANGE')
    page = await pdf.getPage(input.page)
    const viewport = page.getViewport({ scale })
    const width = Math.ceil(viewport.width)
    const height = Math.ceil(viewport.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) throw docError('PDF_RENDER_TOO_LARGE')
    const factory = pdf.canvasFactory as CanvasFactory
    pair = factory.create(width, height)
    const task = page.render({ canvasContext: pair.context, viewport })
    const cancel = () => task.cancel()
    if (signal.aborted) { cancel(); throw docError('ABORTED') }
    signal.addEventListener('abort', cancel, { once: true })
    try { await task.promise } finally { signal.removeEventListener('abort', cancel) }
    if (signal.aborted) throw docError('ABORTED')
    const png = pair.canvas.toBuffer('image/png')
    if (png.byteLength < 8 || png[0] !== 0x89 || png.byteLength > MAX_PNG_BYTES) throw docError('PDF_RENDER_TOO_LARGE')
    const written = await requireOfficeBinaryWriter().write({ path: input.path, bytes: png, expectedHash: input.expectedHash ?? null, signal })
    const hash = createHash('sha256').update(png).digest('hex')
    if (written.hash !== hash || written.bytes !== png.byteLength || written.path !== input.path) throw docError('OFFICE_WRITE_MISMATCH')
    return { path: written.path, hash, bytes: written.bytes, page: input.page, width, height, scale }
  } catch (cause) {
    if (cause instanceof ToolError) throw cause
    const code = (cause as { code?: string })?.code
    if (code === 'ABORTED' || signal.aborted) throw docError('ABORTED')
    if (typeof code === 'string' && code.startsWith('PDF_') || code === 'INVALID_PDF_PAGE_RANGE' || code === 'OFFICE_WRITE_MISMATCH' || code === 'OFFICE_TARGET_EXTENSION' || code === 'INVALID_DRAFT_TARGET' || code === 'PLAN_PATH_NOT_ALLOWED' || code === 'FROZEN_TEST_CHANGE' || code === 'FILE_BASELINE_CONFLICT' || code === 'FILE_BASELINE_MISSING' || code === 'PATH_OUTSIDE_SANDBOX' || code === 'DOCUMENT_NOT_FOUND' || code === 'DOCUMENT_TOO_LARGE' || code === 'DOCUMENT_NOT_A_FILE' || code === 'PATH_OUTSIDE_WORKSPACE') throw cause
    throw docError('PDF_RENDER_FAILED', false, cause)
  } finally {
    signal.removeEventListener('abort', abort)
    page?.cleanup()
    pair && (pdf?.canvasFactory as CanvasFactory | undefined)?.destroy(pair)
    await pdf?.destroy().catch(() => undefined)
    await loading.destroy().catch(() => undefined)
  }
}

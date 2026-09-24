import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { ToolError, type ToolDefinition, type ToolManifest } from '@hunterzhu/pulse-tool-sdk'

const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_PDF_PAGES = 2_000
const MAX_PDF_PAGE_RANGE = 50
const MAX_OUTPUT_CHARS = 50_000
const MAX_XLSX_ENTRIES = 1_000
const MAX_XLSX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
const MAX_XLSX_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_XLSX_SHEETS = 100

const pdfInput = z.object({
  path: z.string().min(1).max(1_024),
  startPage: z.number().int().positive().optional(),
  endPage: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().max(MAX_OUTPUT_CHARS).default(20_000),
}).strict()

const xlsxInput = z.object({
  path: z.string().min(1).max(1_024),
  sheet: z.string().min(1).max(128).optional(),
  maxRows: z.number().int().positive().max(100).default(20),
  maxColumns: z.number().int().positive().max(50).default(20),
}).strict()

type PdfInput = z.infer<typeof pdfInput>
type XlsxInput = z.infer<typeof xlsxInput>

export interface PdfReadOutput {
  path: string
  totalPages: number
  firstPage: number
  lastPage: number
  title?: string
  author?: string
  text: string
  truncated: boolean
}

export interface XlsxInspectOutput {
  path: string
  creator?: string
  title?: string
  subject?: string
  sheetCount: number
  worksheets: Array<{
    id: number
    name: string
    state: string
    rowCount: number
    columnCount: number
    preview?: Array<{ row: number; cells: Array<string | number | boolean | null> }>
  }>
  truncated: boolean
}

function docError(code: string, retryable = false, cause?: unknown): ToolError {
  return new ToolError(code, code, { retryable: retryable || isRetryable(cause) })
}

function isRetryable(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return false
  const code = (cause as NodeJS.ErrnoException).code
  return code === 'EAGAIN' || code === 'EBUSY' || code === 'EMFILE' || code === 'ENFILE' || code === 'ETIMEDOUT'
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function readWorkspaceFile(rootInput: string, path: string, signal: AbortSignal): Promise<{ absolutePath: string; data: Buffer }> {
  if (signal.aborted) throw docError('ABORTED')
  if (isAbsolute(path) || path.includes('\0')) throw docError('PATH_OUTSIDE_WORKSPACE')
  const root = await realpath(rootInput).catch((cause) => { throw docError('WORKSPACE_UNAVAILABLE', false, cause) })
  const candidate = resolve(root, path)
  if (!within(root, candidate)) throw docError('PATH_OUTSIDE_WORKSPACE')
  const candidateEntry = await lstat(candidate).catch((cause) => { throw docError((cause as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_READ_FAILED', false, cause) })
  if (candidateEntry.isSymbolicLink()) throw docError('PATH_OUTSIDE_WORKSPACE')
  const absolutePath = await realpath(candidate).catch((cause) => { throw docError((cause as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_READ_FAILED', false, cause) })
  if (!within(root, absolutePath)) throw docError('PATH_OUTSIDE_WORKSPACE')
  const entry = await lstat(absolutePath).catch((cause) => { throw docError('DOCUMENT_READ_FAILED', false, cause) })
  if (!entry.isFile()) throw docError('DOCUMENT_NOT_A_FILE')
  if (entry.size > MAX_INPUT_BYTES) throw docError('DOCUMENT_TOO_LARGE')
  const data = await readFile(absolutePath, { signal }).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).name === 'AbortError') throw docError('ABORTED')
    throw docError('DOCUMENT_READ_FAILED', false, cause)
  })
  if (signal.aborted) throw docError('ABORTED')
  if (data.byteLength > MAX_INPUT_BYTES) throw docError('DOCUMENT_TOO_LARGE')
  return { absolutePath, data }
}

function pdfText(items: unknown[]): string {
  return items.map((item) => item !== null && typeof item === 'object' && 'str' in item && typeof item.str === 'string' ? item.str : '').join(' ')
}

async function readPdf(root: string, input: PdfInput, signal: AbortSignal): Promise<PdfReadOutput> {
  const { absolutePath, data } = await readWorkspaceFile(root, input.path, signal)
  let destroyDocument: (() => Promise<void>) | undefined
  try {
    const loading = getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false, stopAtErrors: true })
    const pdf = await loading.promise
    destroyDocument = () => pdf.destroy()
    if (pdf.numPages > MAX_PDF_PAGES) throw docError('PDF_PAGE_COUNT_TOO_LARGE')
    const firstPage = input.startPage ?? 1
    const lastPage = input.endPage ?? Math.min(pdf.numPages, firstPage + MAX_PDF_PAGE_RANGE - 1)
    if (firstPage > pdf.numPages || lastPage > pdf.numPages || lastPage < firstPage) throw docError('INVALID_PDF_PAGE_RANGE')
    if (lastPage - firstPage + 1 > MAX_PDF_PAGE_RANGE) throw docError('PDF_PAGE_RANGE_TOO_LARGE')
    const metadata = await pdf.getMetadata()
    const info = metadata.info as Record<string, unknown>
    const chunks: string[] = []
    let used = 0
    let truncated = false
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
      if (signal.aborted) throw docError('ABORTED')
      const page = await pdf.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const text = pdfText(content.items)
        const remaining = input.maxChars - used
        if (remaining <= 0) { truncated = true; break }
        const bounded = text.slice(0, remaining)
        if (bounded.length < text.length) truncated = true
        chunks.push(`--- Page ${pageNumber} ---\n${bounded}`)
        used += bounded.length
      } finally { page.cleanup() }
      if (truncated) break
    }
    return {
      path: input.path,
      totalPages: pdf.numPages,
      firstPage,
      lastPage: Math.min(lastPage, firstPage + chunks.length - 1),
      ...(typeof info.Title === 'string' && info.Title ? { title: info.Title.slice(0, 500) } : {}),
      ...(typeof info.Author === 'string' && info.Author ? { author: info.Author.slice(0, 500) } : {}),
      text: chunks.join('\n\n').slice(0, input.maxChars),
      truncated,
    }
  } catch (cause) {
    if (cause instanceof ToolError) throw cause
    if (signal.aborted) throw docError('ABORTED')
    throw docError('INVALID_PDF', false, cause)
  } finally {
    if (destroyDocument) await destroyDocument().catch(() => undefined)
  }
}

function checkXlsxArchive(data: Buffer<ArrayBufferLike>): void {
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) throw docError('INVALID_XLSX_ARCHIVE')
  const lowerBound = Math.max(0, data.length - 65_557)
  let eocd = -1
  for (let offset = data.length - 22; offset >= lowerBound; offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw docError('INVALID_XLSX_ARCHIVE')
  const disk = data.readUInt16LE(eocd + 4)
  const centralDisk = data.readUInt16LE(eocd + 6)
  const entriesOnDisk = data.readUInt16LE(eocd + 8)
  const entryCount = data.readUInt16LE(eocd + 10)
  const centralSize = data.readUInt32LE(eocd + 12)
  const centralOffset = data.readUInt32LE(eocd + 16)
  const commentLength = data.readUInt16LE(eocd + 20)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || entryCount > MAX_XLSX_ENTRIES || eocd + 22 + commentLength > data.length || centralOffset + centralSize > eocd) throw docError('INVALID_XLSX_ARCHIVE')
  let offset = centralOffset
  let totalUncompressed = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) throw docError('INVALID_XLSX_ARCHIVE')
    const flags = data.readUInt16LE(offset + 8)
    const compressionMethod = data.readUInt16LE(offset + 10)
    const compressed = data.readUInt32LE(offset + 20)
    const uncompressed = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const entryCommentLength = data.readUInt16LE(offset + 32)
    const localOffset = data.readUInt32LE(offset + 42)
    const entrySize = 46 + nameLength + extraLength + entryCommentLength
    if ((flags & 0x1) !== 0 || compressed === 0xffff_ffff || uncompressed === 0xffff_ffff || uncompressed > MAX_XLSX_ENTRY_BYTES) throw docError('UNSUPPORTED_XLSX_ENTRY')
    if (offset + entrySize > data.length || compressed > 0 && uncompressed / compressed > 10_000 || localOffset + 30 > centralOffset || data.readUInt32LE(localOffset) !== 0x04034b50) throw docError('INVALID_XLSX_ARCHIVE')
    const localNameLength = data.readUInt16LE(localOffset + 26)
    const localExtraLength = data.readUInt16LE(localOffset + 28)
    const contentOffset = localOffset + 30 + localNameLength + localExtraLength
    if (contentOffset + compressed > centralOffset || data.readUInt16LE(localOffset + 8) !== compressionMethod) throw docError('INVALID_XLSX_ARCHIVE')
    const compressedData = data.subarray(contentOffset, contentOffset + compressed)
    let actualUncompressed: number
    try {
      if (compressionMethod === 0) actualUncompressed = compressedData.length
      else if (compressionMethod === 8) actualUncompressed = inflateRawSync(compressedData, { maxOutputLength: MAX_XLSX_ENTRY_BYTES + 1 }).byteLength
      else throw docError('UNSUPPORTED_XLSX_COMPRESSION')
    } catch (cause) {
      if (cause instanceof ToolError) throw cause
      throw docError('INVALID_XLSX_ARCHIVE', false, cause)
    }
    if (actualUncompressed !== uncompressed) throw docError('INVALID_XLSX_ARCHIVE')
    totalUncompressed += actualUncompressed
    if (totalUncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) throw docError('XLSX_CONTENT_TOO_LARGE')
    offset += entrySize
  }
  if (offset !== centralOffset + centralSize) throw docError('INVALID_XLSX_ARCHIVE')
}

function cellValue(value: unknown, maxChars: number): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.slice(0, maxChars)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.richText)) return record.richText.map((part) => part !== null && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '').join('').slice(0, maxChars)
    if (typeof record.text === 'string') return record.text.slice(0, maxChars)
    if (typeof record.formula === 'string') return `=${record.formula}`.slice(0, maxChars)
    if (typeof record.error === 'string') return `#${record.error}`.slice(0, maxChars)
    return '[complex value]'
  }
  return String(value).slice(0, maxChars)
}

async function inspectXlsx(root: string, input: XlsxInput, signal: AbortSignal): Promise<XlsxInspectOutput> {
  const { data } = await readWorkspaceFile(root, input.path, signal)
  checkXlsxArchive(Buffer.from(data))
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(Buffer.from(data) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    if (signal.aborted) throw docError('ABORTED')
    const selected = input.sheet === undefined ? undefined : workbook.getWorksheet(input.sheet)
    if (input.sheet !== undefined && !selected) throw docError('XLSX_SHEET_NOT_FOUND')
    if (workbook.worksheets.length > MAX_XLSX_SHEETS) throw docError('XLSX_SHEET_COUNT_TOO_LARGE')
    const sheets = selected ? [selected] : workbook.worksheets
    let remaining = MAX_OUTPUT_CHARS - 20_000
    let truncated = false
    const worksheets: XlsxInspectOutput['worksheets'] = []
    for (const sheet of sheets) {
      if (signal.aborted) throw docError('ABORTED')
      const rowCount = sheet.actualRowCount
      const columnCount = sheet.actualColumnCount
      let preview: XlsxInspectOutput['worksheets'][number]['preview']
      if (selected) {
        preview = []
        if (sheet.columnCount > input.maxColumns) truncated = true
        const previewLimit = Symbol('preview-limit')
        try {
          sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (preview!.length >= input.maxRows || remaining <= 0) { truncated = true; throw previewLimit }
            const cells: Array<string | number | boolean | null> = []
            const columnLimit = Math.min(input.maxColumns, Math.max(1, sheet.columnCount))
            for (let column = 1; column <= columnLimit; column++) {
              const cell = cellValue(row.getCell(column).value, Math.min(2_000, remaining))
              const size = Buffer.byteLength(JSON.stringify(cell), 'utf8')
              if (size > remaining) { truncated = true; remaining = 0; break }
              cells.push(cell)
              remaining -= size
            }
            preview!.push({ row: rowNumber, cells })
            if (remaining <= 0) throw previewLimit
          })
        } catch (cause) { if (cause !== previewLimit) throw cause }
        if (rowCount > input.maxRows) truncated = true
      }
      worksheets.push({ id: sheet.id, name: sheet.name.slice(0, 128), state: String(sheet.state), rowCount, columnCount, ...(preview === undefined ? {} : { preview }) })
    }
    const result: XlsxInspectOutput = {
      path: input.path,
      ...(typeof workbook.creator === 'string' ? { creator: workbook.creator.slice(0, 500) } : {}),
      ...(typeof workbook.title === 'string' ? { title: workbook.title.slice(0, 500) } : {}),
      ...(typeof workbook.subject === 'string' ? { subject: workbook.subject.slice(0, 500) } : {}),
      sheetCount: workbook.worksheets.length,
      worksheets,
      truncated,
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_OUTPUT_CHARS) throw docError('DOCUMENT_OUTPUT_TOO_LARGE')
    return result
  } catch (cause) {
    if (cause instanceof ToolError) throw cause
    if (signal.aborted) throw docError('ABORTED')
    throw docError('INVALID_XLSX', false, cause)
  }
}

function manifest(name: string, description: string, inputSchema: Record<string, unknown>, outputSchema: Record<string, unknown>): ToolManifest {
  return { name, version: '1.0.0', description, tags: ['documents', 'read'], inputSchema, outputSchema, concurrencyClass: 'tool', locks: [], supportsAbortSignal: true, sideEffectPolicy: 'read', retrySafety: 'read_only', defaultTimeoutMs: 60_000, maxResultSummaryBytes: 4_096 }
}

const pdfManifest = manifest('document.pdf.read', 'Extract bounded text and metadata from a PDF in the workspace.',
  { type: 'object', required: ['path'], properties: { path: { type: 'string' }, startPage: { type: 'integer', minimum: 1 }, endPage: { type: 'integer', minimum: 1 }, maxChars: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_CHARS, default: 20_000 } }, additionalProperties: false },
  { type: 'object', required: ['path', 'totalPages', 'firstPage', 'lastPage', 'text', 'truncated'], properties: { path: { type: 'string' }, totalPages: { type: 'integer' }, firstPage: { type: 'integer' }, lastPage: { type: 'integer' }, title: { type: 'string' }, author: { type: 'string' }, text: { type: 'string' }, truncated: { type: 'boolean' } }, additionalProperties: false })

const xlsxManifest = manifest('document.xlsx.inspect', 'List workbook metadata and worksheet dimensions; optionally return a bounded cell preview.',
  { type: 'object', required: ['path'], properties: { path: { type: 'string' }, sheet: { type: 'string' }, maxRows: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, maxColumns: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, additionalProperties: false },
  { type: 'object', required: ['path', 'sheetCount', 'worksheets', 'truncated'], properties: { path: { type: 'string' }, creator: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' }, sheetCount: { type: 'integer' }, worksheets: { type: 'array', items: { type: 'object', required: ['id', 'name', 'state', 'rowCount', 'columnCount'], properties: { id: { type: 'integer' }, name: { type: 'string' }, state: { type: 'string' }, rowCount: { type: 'integer' }, columnCount: { type: 'integer' }, preview: { type: 'array', items: { type: 'object', required: ['row', 'cells'], properties: { row: { type: 'integer' }, cells: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } } }, additionalProperties: false } } }, additionalProperties: false } }, truncated: { type: 'boolean' } }, additionalProperties: false })

export function createDocumentTools(workspaceRoot: string): [ToolDefinition<PdfInput, PdfReadOutput>, ToolDefinition<XlsxInput, XlsxInspectOutput>] {
  const root = resolve(workspaceRoot)
  return [
    {
      manifest: { ...pdfManifest, locks: [{ resource: `workspace:${root}`, mode: 'shared' }], permissions: { workspaceRoots: [root] } },
      validateInput: (input) => pdfInput.parse(input),
      execute: (input, context) => readPdf(root, input, context.signal),
      summarize: (output) => ({ path: output.path, totalPages: output.totalPages, firstPage: output.firstPage, lastPage: output.lastPage, truncated: output.truncated, textPreview: output.text.slice(0, 1_000) }),
    },
    {
      manifest: { ...xlsxManifest, locks: [{ resource: `workspace:${root}`, mode: 'shared' }], permissions: { workspaceRoots: [root] } },
      validateInput: (input) => xlsxInput.parse(input),
      execute: (input, context) => inspectXlsx(root, input, context.signal),
      summarize: (output) => ({ path: output.path, sheetCount: output.sheetCount, worksheets: output.worksheets.map(({ name, rowCount, columnCount, state }) => ({ name, rowCount, columnCount, state })), truncated: output.truncated }),
    },
  ]
}

import { resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { ToolError, type ToolDefinition, type ToolManifest } from '@hunterzhu/pulse-tool-sdk'
import { extractDocxText } from './docx.js'
import { docError, MAX_INPUT_BYTES, MAX_OUTPUT_CHARS, MAX_PDF_PAGE_RANGE, MAX_PDF_PAGES, readWorkspaceFile } from './workspace-file.js'
import { readPptx, type PptxReadRequest, type PptxReadResult } from './pptx-read.js'
import { renderPdfPage, type PdfRenderRequest, type PdfRenderResult } from './pdf-render.js'
import { writeDocx, writePptx, writeXlsx, type DocxWriteRequest, type OfficeWriteResult, type PptxWriteRequest, type XlsxWriteRequest } from './office-generate.js'
export { officeBinaryWriter, requireOfficeBinaryWriter, type OfficeBinaryWriter } from './binary-writer.js'
export { assertOfficeOutputPath } from './output-path.js'
const MAX_XLSX_ENTRIES = 1_000
const MAX_XLSX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
const MAX_XLSX_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_XLSX_SHEETS = 100

const pdfInput = z.object({
  path: z.string().min(1).max(1_024),
  offset: z.number().int().min(0).optional(),
  startPage: z.number().int().positive().optional(),
  endPage: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().max(MAX_OUTPUT_CHARS).default(20_000),
}).strict()

const xlsxInput = z.object({
  path: z.string().min(1).max(1_024),
  sheet: z.string().min(1).max(128).optional(),
  startRow: z.number().int().positive().optional(),
  maxRows: z.number().int().positive().max(100).default(20),
  maxColumns: z.number().int().positive().max(50).default(20),
}).strict()

const docxInput = z.object({
  path: z.string().min(1).max(1_024),
  maxChars: z.number().int().positive().max(MAX_OUTPUT_CHARS).default(20_000),
}).strict()

type PdfInput = z.infer<typeof pdfInput>
type XlsxInput = z.infer<typeof xlsxInput>
type DocxInput = z.infer<typeof docxInput>

export interface DocxReadOutput {
  path: string
  text: string
  chars: number
  truncated: boolean
}

export interface PdfReadOutput {
  path: string
  totalPages: number
  nextPage?: number | null
  nextOffset?: number | null
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

function pdfText(items: unknown[]): string {
  return items.map((item) => item !== null && typeof item === 'object' && 'str' in item && typeof item.str === 'string' ? item.str : '').join(' ')
}

export async function readPdf(root: string, input: PdfInput, signal: AbortSignal): Promise<PdfReadOutput> {
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
    let nextPage: number | null = lastPage < pdf.numPages ? lastPage + 1 : null
    let nextOffset: number | null = nextPage === null ? null : 0
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
      if (signal.aborted) throw docError('ABORTED')
      const page = await pdf.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const pageOffset = pageNumber === firstPage ? input.offset ?? 0 : 0
        const text = pdfText(content.items).slice(pageOffset)
        const remaining = input.maxChars - used
        if (remaining <= 0) { truncated = true; nextPage = pageNumber; nextOffset = pageOffset; break }
        const bounded = text.slice(0, remaining)
        if (bounded.length < text.length) { truncated = true; nextPage = pageNumber; nextOffset = pageOffset + bounded.length }
        chunks.push(input.offset === undefined ? `--- Page ${pageNumber} ---\n${bounded}` : bounded)
        used += bounded.length + (input.offset === undefined ? 0 : 2)
      } finally { page.cleanup() }
      if (truncated) break
    }
    return {
      path: input.path,
      totalPages: pdf.numPages,
      ...(input.offset === undefined ? {} : { nextPage, nextOffset }),
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

export async function inspectXlsx(root: string, input: XlsxInput, signal: AbortSignal): Promise<XlsxInspectOutput> {
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
            if (rowNumber < (input.startRow ?? 1)) return
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
        if (sheet.rowCount >= (input.startRow ?? 1) + input.maxRows) truncated = true
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

export async function readDocx(root: string, input: DocxInput, signal: AbortSignal): Promise<DocxReadOutput> {
  const { data } = await readWorkspaceFile(root, input.path, signal)
  const fullText = await extractDocxText(Buffer.from(data), signal)
  const truncated = fullText.length > input.maxChars
  const text = truncated ? fullText.slice(0, input.maxChars) : fullText
  return {
    path: input.path,
    text,
    chars: text.length,
    truncated,
  }
}

function manifest(name: string, description: string, inputSchema: Record<string, unknown>, outputSchema: Record<string, unknown>, policy: 'read' | 'write' = 'read'): ToolManifest {
  return { name, version: '1.0.0', description, tags: ['documents', policy], inputSchema, outputSchema, concurrencyClass: 'tool', locks: [], supportsAbortSignal: true, sideEffectPolicy: policy, retrySafety: policy === 'read' ? 'read_only' : 'unsafe', defaultTimeoutMs: policy === 'write' ? 120_000 : 60_000, maxResultSummaryBytes: 4_096 }
}

const pdfManifest = manifest('document.pdf.read', 'Extract bounded text and metadata from a PDF in the workspace.',
  { type: 'object', required: ['path'], properties: { path: { type: 'string' }, startPage: { type: 'integer', minimum: 1 }, endPage: { type: 'integer', minimum: 1 }, maxChars: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_CHARS, default: 20_000 } }, additionalProperties: false },
  { type: 'object', required: ['path', 'totalPages', 'firstPage', 'lastPage', 'text', 'truncated'], properties: { path: { type: 'string' }, totalPages: { type: 'integer' }, firstPage: { type: 'integer' }, lastPage: { type: 'integer' }, title: { type: 'string' }, author: { type: 'string' }, text: { type: 'string' }, truncated: { type: 'boolean' } }, additionalProperties: false })

const xlsxManifest = manifest('document.xlsx.inspect', 'List workbook metadata and worksheet dimensions; optionally return a bounded cell preview.',
  { type: 'object', required: ['path'], properties: { path: { type: 'string' }, sheet: { type: 'string' }, startRow: { type: 'integer', minimum: 1 }, maxRows: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, maxColumns: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, additionalProperties: false },
  { type: 'object', required: ['path', 'sheetCount', 'worksheets', 'truncated'], properties: { path: { type: 'string' }, creator: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' }, sheetCount: { type: 'integer' }, worksheets: { type: 'array', items: { type: 'object', required: ['id', 'name', 'state', 'rowCount', 'columnCount'], properties: { id: { type: 'integer' }, name: { type: 'string' }, state: { type: 'string' }, rowCount: { type: 'integer' }, columnCount: { type: 'integer' }, preview: { type: 'array', items: { type: 'object', required: ['row', 'cells'], properties: { row: { type: 'integer' }, cells: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } } }, additionalProperties: false } } }, additionalProperties: false } }, truncated: { type: 'boolean' } }, additionalProperties: false })

const docxManifest = manifest('document.docx.read', 'Extract bounded text from a Word DOCX document in the workspace.',
  { type: 'object', required: ['path'], properties: { path: { type: 'string' }, maxChars: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_CHARS, default: 20_000 } }, additionalProperties: false },
  { type: 'object', required: ['path', 'text', 'chars', 'truncated'], properties: { path: { type: 'string' }, text: { type: 'string' }, chars: { type: 'integer' }, truncated: { type: 'boolean' } }, additionalProperties: false })

const hashSchema = { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{64}$' }, { type: 'null' }] }
const textSchema = { type: 'string', maxLength: 8_000 }
const pptxManifest = manifest('document.pptx.read', 'Read bounded slide text in presentation order. startSlide/endSlide select a window of at most 20 slides; offset is a UTF-16 offset inside the first selected slide. Continue from nextSlide and nextOffset. Does not fetch links, run macros, or expand XML entities.',
  { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Workspace-relative PPTX path.' }, startSlide: { type: 'integer', minimum: 1, description: 'First slide to read, 1-based, in presentation.xml order.' }, endSlide: { type: 'integer', minimum: 1, description: 'Last slide to read, inclusive.' }, offset: { type: 'integer', minimum: 0, description: 'UTF-16 offset within the first selected slide body.' }, maxChars: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_CHARS, default: 20_000, description: 'Maximum slide-body characters in this window.' } }, additionalProperties: false },
  { type: 'object', required: ['path', 'hash', 'totalSlides', 'startSlide', 'endSlide', 'nextSlide', 'nextOffset', 'text', 'truncated'], properties: { path: { type: 'string' }, hash: { type: 'string' }, totalSlides: { type: 'integer' }, startSlide: { type: 'integer' }, endSlide: { type: 'integer' }, nextSlide: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, nextOffset: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, text: { type: 'string' }, truncated: { type: 'boolean' } }, additionalProperties: false })
const pdfRenderManifest = manifest('document.pdf.render', 'Render one PDF page to a PNG file with the installed PDF.js and local canvas. path is the workspace PNG to create. Omit expectedHash to create a new file; pass the current SHA-256 to replace that exact file. No fonts, images, or PDF resources are fetched from the network.',
  { type: 'object', required: ['sourcePath', 'page', 'path'], properties: { sourcePath: { type: 'string', description: 'Workspace-relative PDF.' }, page: { type: 'integer', minimum: 1, description: '1-based page number.' }, path: { type: 'string', description: 'Workspace-relative PNG output path.' }, scale: { type: 'number', exclusiveMinimum: 0, maximum: 4, description: 'Zoom relative to 72 DPI. Do not combine with dpi.' }, dpi: { type: 'integer', minimum: 36, maximum: 300, description: 'Target resolution. Do not combine with scale.' }, expectedHash: { ...hashSchema, description: 'Null or omitted creates a new file. A SHA-256 replaces that exact binary.' } }, additionalProperties: false },
  { type: 'object', required: ['path', 'hash', 'bytes', 'page', 'width', 'height', 'scale'], properties: { path: { type: 'string' }, hash: { type: 'string' }, bytes: { type: 'integer' }, page: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, scale: { type: 'number' } }, additionalProperties: false }, 'write')
const docxWriteManifest = manifest('document.docx.write', 'Create a real DOCX file from bounded headings, paragraphs, lists, and tables. Strings are stored as text. path is the workspace output. Omit expectedHash to create; pass the current SHA-256 to replace that exact file.',
  { type: 'object', required: ['path', 'blocks'], properties: { path: { type: 'string' }, expectedHash: hashSchema, title: { type: 'string', maxLength: 200 }, blocks: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { type: { type: 'string', enum: ['heading', 'paragraph', 'list', 'table'] }, level: { type: 'integer', enum: [1, 2, 3] }, text: textSchema, ordered: { type: 'boolean' }, header: { type: 'boolean' }, items: { type: 'array', items: { type: 'string', maxLength: 4_000 }, maxItems: 50 }, rows: { type: 'array', items: { type: 'array', items: { type: 'string', maxLength: 2_000 }, maxItems: 20 }, maxItems: 100 } }, required: ['type'], additionalProperties: false } } }, additionalProperties: false },
  { type: 'object', required: ['path', 'hash', 'bytes', 'blocks'], properties: { path: { type: 'string' }, hash: { type: 'string' }, bytes: { type: 'integer' }, blocks: { type: 'integer' } }, additionalProperties: false }, 'write')
const xlsxWriteManifest = manifest('document.xlsx.write', 'Create a real XLSX workbook. Cell strings are stored as text, even when they start with =. Use the formula object only for local arithmetic or ABS, AVERAGE, COUNT, COUNTA, INT, MAX, MIN, MOD, POWER, PRODUCT, ROUND, SQRT, and SUM. DDE, external references, and hyperlinks are rejected before any file is written. Omit expectedHash to create; pass the current SHA-256 to replace that exact file.',
  { type: 'object', required: ['path', 'sheets'], properties: { path: { type: 'string' }, expectedHash: hashSchema, sheets: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['name', 'rows'], properties: { name: { type: 'string', maxLength: 31 }, header: { type: 'boolean', description: 'Bold the first row.' }, rows: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'array', minItems: 1, maxItems: 50, items: { anyOf: [{ type: 'string', maxLength: 2_000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'object', required: ['formula'], properties: { formula: { type: 'string', maxLength: 256, description: 'Local arithmetic or an allowed function, without a leading =. DDE, pipes, external workbooks, and links are rejected.' } }, additionalProperties: false } ] } } } }, additionalProperties: false } } }, additionalProperties: false },
  { type: 'object', required: ['path', 'hash', 'bytes', 'sheets'], properties: { path: { type: 'string' }, hash: { type: 'string' }, bytes: { type: 'integer' }, sheets: { type: 'integer' } }, additionalProperties: false }, 'write')
const pptxWriteManifest = manifest('document.pptx.write', 'Create a real PPTX deck. The document title is stored in core properties. Slides stay in the given order, with a title, optional bullets, an optional text table, and an optional local PNG or JPEG. Content that does not fit one slide continues on later slides; a deck that still cannot fit is rejected before writing. No remote images, templates, or macros. Omit expectedHash to create; pass the current SHA-256 to replace that exact file.',
  { type: 'object', required: ['path', 'slides'], properties: { path: { type: 'string' }, expectedHash: hashSchema, title: { type: 'string', maxLength: 200 }, slides: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 500 }, bullets: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 2_000 } }, table: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 500 } } } }, additionalProperties: false }, imagePath: { type: 'string', description: 'Workspace-relative PNG or JPEG. URLs are rejected.' } }, additionalProperties: false } } }, additionalProperties: false },
  { type: 'object', required: ['path', 'hash', 'bytes', 'slides'], properties: { path: { type: 'string' }, hash: { type: 'string' }, bytes: { type: 'integer' }, slides: { type: 'integer' } }, additionalProperties: false }, 'write')

const pptxReadInput = z.object({ path: z.string().min(1).max(1_024), startSlide: z.number().int().positive().optional(), endSlide: z.number().int().positive().optional(), offset: z.number().int().min(0).optional(), maxChars: z.number().int().positive().max(MAX_OUTPUT_CHARS).default(20_000) }).strict()
const pdfRenderInput = z.object({ sourcePath: z.string().min(1).max(1_024), page: z.number().int().positive(), path: z.string().min(1).max(1_024), scale: z.number().positive().max(4).optional(), dpi: z.number().int().min(36).max(300).optional(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }).strict()
const docxBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(), text: z.string().max(8_000) }).strict(),
  z.object({ type: z.literal('paragraph'), text: z.string().max(8_000) }).strict(),
  z.object({ type: z.literal('list'), ordered: z.boolean().optional(), items: z.array(z.string().max(4_000)).min(1).max(50) }).strict(),
  z.object({ type: z.literal('table'), header: z.boolean().optional(), rows: z.array(z.array(z.string().max(2_000)).min(1).max(20)).min(1).max(100) }).strict(),
])
const docxWriteInput = z.object({ path: z.string().min(1).max(1_024), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), title: z.string().max(200).optional(), blocks: z.array(docxBlock).min(1).max(100) }).strict()
const xlsxCell = z.union([z.string().max(2_000), z.number(), z.boolean(), z.null(), z.object({ formula: z.string().min(1).max(256) }).strict()])
const xlsxWriteInput = z.object({ path: z.string().min(1).max(1_024), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), sheets: z.array(z.object({ name: z.string().min(1).max(31), header: z.boolean().optional(), rows: z.array(z.array(xlsxCell).min(1).max(50)).min(1).max(500) }).strict()).min(1).max(20) }).strict()
const pptxWriteInput = z.object({ path: z.string().min(1).max(1_024), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), title: z.string().max(200).optional(), slides: z.array(z.object({ title: z.string().max(500), bullets: z.array(z.string().max(2_000)).max(30).optional(), table: z.object({ rows: z.array(z.array(z.string().max(500)).min(1).max(12)).min(1).max(30) }).strict().optional(), imagePath: z.string().min(1).max(1_024).optional() }).strict()).min(1).max(40) }).strict()

export function createDocumentTools(workspaceRoot: string): [
  ToolDefinition<PdfInput, PdfReadOutput>,
  ToolDefinition<XlsxInput, XlsxInspectOutput>,
  ToolDefinition<DocxInput, DocxReadOutput>,
  ToolDefinition<PptxReadRequest, PptxReadResult>,
  ToolDefinition<PdfRenderRequest, PdfRenderResult>,
  ToolDefinition<DocxWriteRequest, OfficeWriteResult & { blocks: number }>,
  ToolDefinition<XlsxWriteRequest, OfficeWriteResult & { sheets: number }>,
  ToolDefinition<PptxWriteRequest, OfficeWriteResult & { slides: number }>,
] {
  const root = resolve(workspaceRoot)
  const shared = { locks: [{ resource: `workspace:${root}`, mode: 'shared' as const }], permissions: { workspaceRoots: [root] } }
  const fileLock = (path: string) => [{ resource: `workspace:${root}`, mode: 'shared' as const }, { resource: `file:${resolve(root, path)}`, mode: 'exclusive' as const }]
  return [
    {
      manifest: { ...pdfManifest, ...shared },
      validateInput: (input) => pdfInput.parse(input),
      execute: (input, context) => readPdf(root, input, context.signal),
      summarize: (output) => ({ path: output.path, totalPages: output.totalPages, firstPage: output.firstPage, lastPage: output.lastPage, truncated: output.truncated, textPreview: output.text.slice(0, 1_000) }),
    },
    {
      manifest: { ...xlsxManifest, ...shared },
      validateInput: (input) => xlsxInput.parse(input),
      execute: (input, context) => inspectXlsx(root, input, context.signal),
      summarize: (output) => ({ path: output.path, sheetCount: output.sheetCount, worksheets: output.worksheets.map(({ name, rowCount, columnCount, state }) => ({ name, rowCount, columnCount, state })), truncated: output.truncated }),
    },
    {
      manifest: { ...docxManifest, ...shared },
      validateInput: (input) => docxInput.parse(input),
      execute: (input, context) => readDocx(root, input, context.signal),
      summarize: (output) => ({ path: output.path, chars: output.chars, truncated: output.truncated, textPreview: output.text.slice(0, 1_000) }),
    },
    {
      manifest: { ...pptxManifest, ...shared },
      validateInput: (input) => pptxReadInput.parse(input),
      execute: (input, context) => readPptx(root, input, context.signal),
      summarize: (output) => ({ path: output.path, hash: output.hash, totalSlides: output.totalSlides, startSlide: output.startSlide, endSlide: output.endSlide, nextSlide: output.nextSlide, nextOffset: output.nextOffset, truncated: output.truncated, textPreview: output.text.slice(0, 1_000) }),
    },
    {
      manifest: { ...pdfRenderManifest, permissions: { workspaceRoots: [root] } },
      resolveResources: (input) => [...fileLock(input.path), { resource: `file:${resolve(root, input.sourcePath)}`, mode: 'shared' }],
      validateInput: (input) => pdfRenderInput.parse(input),
      execute: (input, context) => renderPdfPage(root, input, context.signal),
      summarize: (output) => ({ path: output.path, hash: output.hash, bytes: output.bytes, page: output.page, width: output.width, height: output.height }),
    },
    {
      manifest: { ...docxWriteManifest, permissions: { workspaceRoots: [root] } },
      resolveResources: (input) => fileLock(input.path),
      validateInput: (input) => docxWriteInput.parse(input),
      execute: (input, context) => writeDocx(root, input, context.signal),
      summarize: (output) => ({ path: output.path, hash: output.hash, bytes: output.bytes, blocks: output.blocks }),
    },
    {
      manifest: { ...xlsxWriteManifest, permissions: { workspaceRoots: [root] } },
      resolveResources: (input) => fileLock(input.path),
      validateInput: (input) => xlsxWriteInput.parse(input),
      execute: (input, context) => writeXlsx(root, input, context.signal),
      summarize: (output) => ({ path: output.path, hash: output.hash, bytes: output.bytes, sheets: output.sheets }),
    },
    {
      manifest: { ...pptxWriteManifest, permissions: { workspaceRoots: [root] } },
      resolveResources: (input) => fileLock(input.path),
      validateInput: (input) => pptxWriteInput.parse(input),
      execute: (input, context) => writePptx(root, input, context.signal),
      summarize: (output) => ({ path: output.path, hash: output.hash, bytes: output.bytes, slides: output.slides }),
    },
  ]
}

/** Apply the same bounded ZIP admission used by XLSX before parsing DOCX. */
export function validateOfficeArchive(data: Buffer): void { checkXlsxArchive(data) }

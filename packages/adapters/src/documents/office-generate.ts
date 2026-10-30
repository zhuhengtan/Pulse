import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { docError, readWorkspaceFile } from './workspace-file.js'
import { assertOfficeOutputPath, type OfficeOutputKind } from './output-path.js'
import { requireOfficeBinaryWriter } from './binary-writer.js'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_PPTX_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export type DocxBlock =
  | { type: 'heading'; level?: 1 | 2 | 3 | undefined; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered?: boolean | undefined; items: string[] }
  | { type: 'table'; header?: boolean | undefined; rows: string[][] }

export interface DocxWriteRequest {
  path: string
  expectedHash?: string | null | undefined
  title?: string | undefined
  blocks: DocxBlock[]
}

export type XlsxCell = string | number | boolean | null | { formula: string }

export interface XlsxWriteRequest {
  path: string
  expectedHash?: string | null | undefined
  sheets: Array<{ name: string; header?: boolean | undefined; rows: XlsxCell[][] }>
}

export interface PptxSlideInput {
  title: string
  bullets?: string[] | undefined
  table?: { rows: string[][] } | undefined
  imagePath?: string | undefined
}

export interface PptxWriteRequest {
  path: string
  expectedHash?: string | null | undefined
  title?: string | undefined
  slides: PptxSlideInput[]
}

export interface OfficeWriteResult { path: string; hash: string; bytes: number }

function xmlText(value: string): string {
  let clean = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000) clean += char
  }
  return clean.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function assertText(value: string, max: number, code: string): string {
  if (typeof value !== 'string' || value.length > max) throw docError(code)
  return value
}

async function commit(kind: OfficeOutputKind, path: string, bytes: Uint8Array, expectedHash: string | null | undefined, signal: AbortSignal, limit: number): Promise<OfficeWriteResult> {
  if (signal.aborted) throw docError('ABORTED')
  assertOfficeOutputPath(kind, path)
  if (bytes.byteLength > limit) throw docError('OFFICE_OUTPUT_TOO_LARGE')
  const written = await requireOfficeBinaryWriter().write({ path, bytes, expectedHash: expectedHash ?? null, signal })
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (written.hash !== hash || written.bytes !== bytes.byteLength || written.path !== path) throw docError('OFFICE_WRITE_MISMATCH')
  return { path: written.path, hash, bytes: written.bytes }
}

function paragraph(text: string, style?: string, numbering?: { id: number }): string {
  const props = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    numbering ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numbering.id}"/></w:numPr>` : '',
  ].join('')
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r></w:p>`
}

function docxTable(rows: string[][], header: boolean): string {
  const width = Math.max(...rows.map((row) => row.length))
  const grid = Array.from({ length: width }, () => '<w:gridCol w:w="2400"/>').join('')
  const body = rows.map((row, index) => `<w:tr>${Array.from({ length: width }, (_, column) => {
    const text = row[column] ?? ''
    const bold = header && index === 0 ? '<w:rPr><w:b/></w:rPr>' : ''
    return `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r>${bold}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r></w:p></w:tc>`
  }).join('')}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
}

function docxDocument(input: DocxWriteRequest): { document: string; title?: string; numbering: string } {
  if (input.blocks.length < 1 || input.blocks.length > 100) throw docError('DOCX_CONTENT_OUT_OF_RANGE')
  const parts: string[] = []
  const orderedIds: number[] = []
  let nextOrdered = 2
  for (const block of input.blocks) {
    if (block.type === 'heading') {
      const level = block.level ?? 1
      if (![1, 2, 3].includes(level)) throw docError('DOCX_CONTENT_OUT_OF_RANGE')
      parts.push(paragraph(assertText(block.text, 8_000, 'DOCX_CONTENT_OUT_OF_RANGE'), `Heading${level}`))
    } else if (block.type === 'paragraph') {
      parts.push(paragraph(assertText(block.text, 8_000, 'DOCX_CONTENT_OUT_OF_RANGE')))
    } else if (block.type === 'list') {
      if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 50) throw docError('DOCX_CONTENT_OUT_OF_RANGE')
      const ordered = block.ordered === true
      const id = ordered ? nextOrdered++ : 1
      if (ordered) orderedIds.push(id)
      for (const item of block.items) parts.push(paragraph(assertText(item, 4_000, 'DOCX_CONTENT_OUT_OF_RANGE'), undefined, { id }))
    } else if (block.type === 'table') {
      if (!Array.isArray(block.rows) || block.rows.length < 1 || block.rows.length > 100) throw docError('DOCX_CONTENT_OUT_OF_RANGE')
      const rows = block.rows.map((row) => {
        if (!Array.isArray(row) || row.length < 1 || row.length > 20) throw docError('DOCX_CONTENT_OUT_OF_RANGE')
        return row.map((cell) => assertText(cell, 2_000, 'DOCX_CONTENT_OUT_OF_RANGE'))
      })
      parts.push(docxTable(rows, block.header === true))
    } else throw docError('DOCX_CONTENT_OUT_OF_RANGE')
  }
  const title = input.title === undefined ? undefined : assertText(input.title, 200, 'DOCX_CONTENT_OUT_OF_RANGE')
  return {
    document: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    ...(title === undefined ? {} : { title }),
    numbering: numberingXml(orderedIds),
  }
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`

function numberingXml(orderedIds: number[]): string {
  const ids = orderedIds.length > 0 ? orderedIds : [2]
  const nums = [
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
    ...ids.map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`),
  ]
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>
  ${nums.join('')}
</w:numbering>`
}

export async function writeDocx(_root: string, input: DocxWriteRequest, signal: AbortSignal): Promise<OfficeWriteResult & { blocks: number }> {
  assertOfficeOutputPath('docx', input.path)
  const { document, title, numbering } = docxDocument(input)
  if (signal.aborted) throw docError('ABORTED')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  ${title === undefined ? '' : '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'}
</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file('word/document.xml', document)
  if (title !== undefined) {
    zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlText(title)}</dc:title></cp:coreProperties>`)
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`)
  }
  zip.file('word/styles.xml', DOCX_STYLES)
  zip.file('word/numbering.xml', numbering)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  const saved = await commit('docx', input.path, bytes, input.expectedHash, signal, MAX_OUTPUT_BYTES)
  return { ...saved, blocks: input.blocks.length }
}

const SAFE_FORMULA_FUNCTIONS = new Set(['ABS', 'AVERAGE', 'COUNT', 'COUNTA', 'INT', 'MAX', 'MIN', 'MOD', 'POWER', 'PRODUCT', 'ROUND', 'SQRT', 'SUM'])

function assertFormula(formula: string): string {
  const text = formula.trim()
  if (!text || text.length > 256 || text.startsWith('=') || /[|'"`\\[\]!#@]|https?:|ftp:|file:/i.test(text) || !/^[0-9A-Za-z_+\-*/^&=<>.,():\s%$]+$/.test(text)) throw docError('OFFICE_FORMULA_FORBIDDEN')
  for (const word of text.replaceAll('$', '').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (/^[A-Za-z]{1,3}[0-9]{1,7}$/.test(word)) continue
    if (SAFE_FORMULA_FUNCTIONS.has(word.toUpperCase()) && new RegExp(`(?:^|[^A-Za-z0-9_])${word}\\s*\\(`, 'i').test(text)) continue
    throw docError('OFFICE_FORMULA_FORBIDDEN')
  }
  return text
}

export async function writeXlsx(_root: string, input: XlsxWriteRequest, signal: AbortSignal): Promise<OfficeWriteResult & { sheets: number }> {
  assertOfficeOutputPath('xlsx', input.path)
  if (!Array.isArray(input.sheets) || input.sheets.length < 1 || input.sheets.length > 20) throw docError('XLSX_CONTENT_OUT_OF_RANGE')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Pulse'
  const names = new Set<string>()
  for (const sheet of input.sheets) {
    if (signal.aborted) throw docError('ABORTED')
    const name = assertText(sheet.name, 31, 'INVALID_XLSX_SHEET_NAME').trim()
    if (!name || /[:\\/?*[\]]/.test(name) || names.has(name)) throw docError('INVALID_XLSX_SHEET_NAME')
    names.add(name)
    if (!Array.isArray(sheet.rows) || sheet.rows.length < 1 || sheet.rows.length > 500) throw docError('XLSX_CONTENT_OUT_OF_RANGE')
    const worksheet = workbook.addWorksheet(name)
    sheet.rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row) || row.length < 1 || row.length > 50) throw docError('XLSX_CONTENT_OUT_OF_RANGE')
      const values = row.map((cell) => {
        if (cell === null || typeof cell === 'number' || typeof cell === 'boolean') return cell
        if (typeof cell === 'string') return assertText(cell, 2_000, 'XLSX_CONTENT_OUT_OF_RANGE')
        if (cell && typeof cell === 'object' && typeof cell.formula === 'string' && Object.keys(cell).length === 1) return { formula: assertFormula(cell.formula) }
        throw docError('XLSX_CONTENT_OUT_OF_RANGE')
      })
      const written = worksheet.addRow(values)
      if (sheet.header === true && rowIndex === 0) written.font = { bold: true }
    })
  }
  if (signal.aborted) throw docError('ABORTED')
  const raw = await workbook.xlsx.writeBuffer()
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const saved = await commit('xlsx', input.path, bytes, input.expectedHash, signal, MAX_OUTPUT_BYTES)
  return { ...saved, sheets: input.sheets.length }
}

const SLIDE_CX = 12_192_000
const SLIDE_CY = 6_858_000
const SLIDE_MARGIN = 457_200
const TITLE_Y = 274_320
const TITLE_H = 1_143_000
const CONTENT_Y = 1_600_200
const CONTENT_H = SLIDE_CY - SLIDE_MARGIN - CONTENT_Y
const IMAGE_BOX = 1_371_600
const IMAGE_GAP = 114_300
const SLIDE_WIDE = SLIDE_CX - SLIDE_MARGIN * 2
const SLIDE_NARROW = SLIDE_WIDE - IMAGE_BOX - IMAGE_GAP
const MAX_PHYSICAL_SLIDES = 80
const BULLET_EM = 228_600
const BULLET_LINE = 274_320
const CELL_EM = 200_000
const CELL_LINE = 228_600
const MIN_ROW_H = 370_840
const BODY_INSET_X = 91_440
const BODY_INSET_Y = 45_720
const BULLET_MAR_L = 342_900

function textBodyPr(): string {
  return `<a:bodyPr anchor="t" lIns="${BODY_INSET_X}" tIns="${BODY_INSET_Y}" rIns="${BODY_INSET_X}" bIns="${BODY_INSET_Y}"/>`
}

function drawingText(text: string, size: number, bullet = false): string {
  const spacing = `<a:lnSpc><a:spcPts val="${Math.round(size * 1.2)}"/></a:lnSpc>`
  const marker = bullet ? '<a:buFont typeface="Hiragino Sans GB"/><a:buChar char="•"/>' : ''
  const indent = bullet ? ` marL="${BULLET_MAR_L}" indent="-171450"` : ''
  return `<a:p><a:pPr${indent}>${spacing}${marker}</a:pPr><a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${size}" dirty="0"><a:solidFill><a:srgbClr val="1F2933"/></a:solidFill><a:latin typeface="Hiragino Sans GB"/><a:ea typeface="Hiragino Sans GB"/><a:cs typeface="Hiragino Sans GB"/></a:rPr><a:t>${xmlText(text)}</a:t></a:r></a:p>`
}

function textUnits(text: string): string[] {
  return Array.from(text)
}

function contentWidth(shapeWidth: number, bullet: boolean): number {
  return Math.max(1, shapeWidth - BODY_INSET_X * 2 - (bullet ? BULLET_MAR_L : 0))
}

function unitsPerLine(width: number, em: number, slack = false): number {
  return Math.max(1, Math.floor(Math.max(0, width - (slack ? em : 0)) / em))
}

function pieceHeight(text: string, width: number, em: number, line: number, slack = false): number {
  return Math.max(1, Math.ceil(textUnits(text).length / unitsPerLine(width, em, slack))) * line
}

function splitPieces(text: string, width: number, em: number, line: number, maxHeight: number, slack = false): string[] {
  const size = unitsPerLine(width, em, slack) * Math.max(1, Math.floor(maxHeight / line))
  const units = textUnits(text)
  if (units.length === 0) return ['']
  const parts: string[] = []
  for (let index = 0; index < units.length; index += size) parts.push(units.slice(index, index + size).join(''))
  return parts
}

function layoutTitle(title: string): { text: string; size: number; overflow: string } {
  const width = contentWidth(SLIDE_WIDE, false)
  const inner = TITLE_H - BODY_INSET_Y * 2
  for (const size of [3200, 2400, 1600]) {
    const em = size * 127
    if (pieceHeight(title, width, em, Math.ceil(em * 1.2), true) <= inner) return { text: title, size, overflow: '' }
  }
  const em = 1600 * 127
  const line = Math.ceil(em * 1.2)
  const count = unitsPerLine(width, em, true) * Math.max(1, Math.floor(inner / line))
  const units = textUnits(title)
  return { text: units.slice(0, count).join(''), size: 1600, overflow: units.slice(count).join('') }
}

function normalizeTable(rows: string[][]): string[][] {
  if (rows.length === 0) return rows
  const columns = Math.max(...rows.map((row) => row.length))
  return rows.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? ''))
}

function columnInner(width: number, columns: number): number {
  const count = Math.max(1, columns)
  const base = Math.floor(width / count)
  const narrow = Math.min(base, width - base * (count - 1))
  return Math.max(1, narrow - BODY_INSET_X * 2)
}

function rowHeight(row: string[], width: number): number {
  const inner = columnInner(width, row.length)
  const lines = Math.max(1, ...row.map((cell) => Math.ceil(Math.max(1, textUnits(cell).length) / unitsPerLine(inner, CELL_EM))))
  return Math.max(MIN_ROW_H, lines * CELL_LINE + BODY_INSET_Y * 2)
}

function splitRow(row: string[], width: number): string[][] {
  const inner = columnInner(width, row.length)
  const size = unitsPerLine(inner, CELL_EM) * Math.max(1, Math.floor((CONTENT_H - BODY_INSET_Y * 2) / CELL_LINE))
  const parts = row.map((cell) => {
    const units = textUnits(cell)
    if (units.length === 0) return ['']
    const chunks: string[] = []
    for (let index = 0; index < units.length; index += size) chunks.push(units.slice(index, index + size).join(''))
    return chunks
  })
  const count = Math.max(1, ...parts.map((part) => part.length))
  return Array.from({ length: count }, (_, index) => parts.map((part) => part[index] ?? ''))
}

interface FlowText { text: string; bullet: boolean }
interface SlidePage {
  title: string
  titleSize: number
  texts: FlowText[]
  textHeight: number
  rows: string[][]
  rowHeights: number[]
  textWidth: number
  tableWidth: number
  image: boolean
}

function textBoxHeight(textHeight: number, count: number): number {
  return count === 0 ? 0 : textHeight + BODY_INSET_Y * 2
}

function paginateContent(title: string, titleSize: number, texts: FlowText[], rows: string[][], image: boolean): SlidePage[] {
  const measure = image ? SLIDE_NARROW : SLIDE_WIDE
  const inner = CONTENT_H - BODY_INSET_Y * 2
  const pieces = texts.flatMap((item) => splitPieces(item.text, contentWidth(measure, item.bullet), BULLET_EM, BULLET_LINE, inner, true).map((text) => ({ text, bullet: item.bullet })))
  const normalized = normalizeTable(rows)
  const tableRows = normalized.flatMap((row) => rowHeight(row, measure) <= CONTENT_H ? [row] : splitRow(row, measure))
  const pages: SlidePage[] = []
  let page = blank(true)
  function blank(first: boolean): SlidePage {
    return { title, titleSize, texts: [], textHeight: 0, rows: [], rowHeights: [], textWidth: first && image ? SLIDE_NARROW : SLIDE_WIDE, tableWidth: measure, image: first && image }
  }
  function used(): number {
    return textBoxHeight(page.textHeight, page.texts.length) + page.rowHeights.reduce((sum, height) => sum + height, 0)
  }
  function nextPage(): void {
    pages.push(page)
    if (pages.length >= MAX_PHYSICAL_SLIDES) throw docError('PPTX_LAYOUT_REJECTED')
    page = blank(false)
  }
  for (const item of pieces) {
    let height = pieceHeight(item.text, contentWidth(page.textWidth, item.bullet), BULLET_EM, BULLET_LINE, true)
    if (textBoxHeight(page.textHeight + height, page.texts.length + 1) + page.rowHeights.reduce((sum, value) => sum + value, 0) > CONTENT_H && (page.texts.length > 0 || page.rows.length > 0)) {
      nextPage()
      height = pieceHeight(item.text, contentWidth(page.textWidth, item.bullet), BULLET_EM, BULLET_LINE, true)
    }
    page.texts.push(item)
    page.textHeight += height
  }
  for (const row of tableRows) {
    const height = rowHeight(row, measure)
    if (used() + height > CONTENT_H && (page.texts.length > 0 || page.rows.length > 0)) nextPage()
    page.rows.push(row)
    page.rowHeights.push(height)
  }
  pages.push(page)
  if (pages.length > MAX_PHYSICAL_SLIDES) throw docError('PPTX_LAYOUT_REJECTED')
  return pages
}

function tableXml(rows: string[][], heights: number[], y: number, width: number): string {
  const columns = Math.max(...rows.map((row) => row.length))
  const base = Math.floor(width / columns)
  const grid = Array.from({ length: columns }, (_, index) => `<a:gridCol w="${index === columns - 1 ? width - base * (columns - 1) : base}"/>`).join('')
  const body = rows.map((row, index) => `<a:tr h="${heights[index]}">${Array.from({ length: columns }, (_, column) => `<a:tc><a:txBody>${textBodyPr()}<a:lstStyle/>${drawingText(row[column] ?? '', 1400)}</a:txBody><a:tcPr marL="0" marR="0" marT="0" marB="0"/></a:tc>`).join('')}</a:tr>`).join('')
  const cy = heights.reduce((sum, height) => sum + height, 0)
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${SLIDE_MARGIN}" y="${y}"/><a:ext cx="${width}" cy="${cy}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

function imagePart(bytes: Buffer): { extension: 'png' | 'jpeg'; contentType: string } {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw docError('PPTX_IMAGE_TOO_LARGE')
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { extension: 'png', contentType: 'image/png' }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: 'jpeg', contentType: 'image/jpeg' }
  throw docError('PPTX_IMAGE_UNSUPPORTED')
}

const PPTX_THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Pulse"><a:themeElements><a:clrScheme name="Pulse"><a:dk1><a:srgbClr val="1F2933"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="334155"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="0F766E"/></a:accent1><a:accent2><a:srgbClr val="0369A1"/></a:accent2><a:accent3><a:srgbClr val="B45309"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="BE123C"/></a:accent5><a:accent6><a:srgbClr val="15803D"/></a:accent6><a:hlink><a:srgbClr val="0369A1"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Pulse"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="Hiragino Sans GB"/><a:cs typeface="Hiragino Sans GB"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Hiragino Sans GB"/><a:cs typeface="Hiragino Sans GB"/></a:minorFont></a:fontScheme><a:fmtScheme name="Pulse"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

interface PreparedSlide extends SlidePage {
  imageFile?: { id: number; extension: 'png' | 'jpeg' } | undefined
}

export async function writePptx(root: string, input: PptxWriteRequest, signal: AbortSignal): Promise<OfficeWriteResult & { slides: number }> {
  assertOfficeOutputPath('pptx', input.path)
  if (!Array.isArray(input.slides) || input.slides.length < 1 || input.slides.length > 40) throw docError('PPTX_CONTENT_OUT_OF_RANGE')
  const documentTitle = input.title === undefined ? undefined : assertText(input.title, 200, 'PPTX_CONTENT_OUT_OF_RANGE')
  const zip = new JSZip()
  const contentOverrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
  ]
  const defaults = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>', '<Default Extension="xml" ContentType="application/xml"/>']
  const presentationRels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>']
  const slideIds: string[] = []
  const prepared: PreparedSlide[] = []
  let imageCount = 0
  for (const slide of input.slides) {
    if (signal.aborted) throw docError('ABORTED')
    const title = assertText(slide.title, 500, 'PPTX_CONTENT_OUT_OF_RANGE')
    const fitted = layoutTitle(title)
    const texts: FlowText[] = []
    if (fitted.overflow) texts.push({ text: fitted.overflow, bullet: false })
    const bullets = slide.bullets ?? []
    if (bullets.length > 30) throw docError('PPTX_CONTENT_OUT_OF_RANGE')
    for (const item of bullets) texts.push({ text: assertText(item, 2_000, 'PPTX_CONTENT_OUT_OF_RANGE'), bullet: true })
    let rows: string[][] = []
    if (slide.table) {
      if (!Array.isArray(slide.table.rows) || slide.table.rows.length < 1 || slide.table.rows.length > 30) throw docError('PPTX_CONTENT_OUT_OF_RANGE')
      rows = slide.table.rows.map((row) => {
        if (!Array.isArray(row) || row.length < 1 || row.length > 12) throw docError('PPTX_CONTENT_OUT_OF_RANGE')
        return row.map((cell) => assertText(cell, 500, 'PPTX_CONTENT_OUT_OF_RANGE'))
      })
    }
    let imageFile: PreparedSlide['imageFile']
    if (slide.imagePath !== undefined) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(slide.imagePath)) throw docError('PPTX_IMAGE_UNSUPPORTED')
      const image = await readWorkspaceFile(root, slide.imagePath, signal)
      const kind = imagePart(Buffer.from(image.data))
      imageCount += 1
      const media = `ppt/media/image${imageCount}.${kind.extension}`
      zip.file(media, image.data)
      if (!defaults.some((item) => item.includes(`Extension="${kind.extension}"`))) defaults.push(`<Default Extension="${kind.extension}" ContentType="${kind.contentType}"/>`)
      imageFile = { id: imageCount, extension: kind.extension }
    }
    const pages = paginateContent(fitted.text, fitted.size, texts, rows, imageFile !== undefined)
    if (prepared.length + pages.length > MAX_PHYSICAL_SLIDES) throw docError('PPTX_LAYOUT_REJECTED')
    prepared.push(...pages.map((page, index) => ({ ...page, ...(index === 0 && imageFile ? { imageFile } : {}) })))
  }
  for (const [index, page] of prepared.entries()) {
    if (signal.aborted) throw docError('ABORTED')
    const number = index + 1
    const rels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>']
    const box = textBoxHeight(page.textHeight, page.texts.length)
    const body = page.texts.length === 0 ? '' : `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${SLIDE_MARGIN}" y="${CONTENT_Y}"/><a:ext cx="${page.textWidth}" cy="${box}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody>${textBodyPr()}<a:lstStyle/>${page.texts.map((item) => drawingText(item.text, 1800, item.bullet)).join('')}</p:txBody></p:sp>`
    const table = page.rows.length === 0 ? '' : tableXml(page.rows, page.rowHeights, CONTENT_Y + box, page.tableWidth)
    let picture = ''
    if (page.imageFile) {
      rels.push(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${page.imageFile.id}.${page.imageFile.extension}"/>`)
      picture = `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${SLIDE_MARGIN + page.textWidth + IMAGE_GAP}" y="${CONTENT_Y}"/><a:ext cx="${IMAGE_BOX}" cy="${IMAGE_BOX}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    }
    contentOverrides.push(`<Override PartName="/ppt/slides/slide${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    presentationRels.push(`<Relationship Id="rId${number + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${number}.xml"/>`)
    slideIds.push(`<p:sldId id="${255 + number}" r:id="rId${number + 1}"/>`)
    zip.file(`ppt/slides/slide${number}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${SLIDE_MARGIN}" y="${TITLE_Y}"/><a:ext cx="${SLIDE_WIDE}" cy="${TITLE_H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody>${textBodyPr()}<a:lstStyle/>${drawingText(page.title, page.titleSize)}</p:txBody></p:sp>${body}${table}${picture}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
    zip.file(`ppt/slides/_rels/slide${number}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`)
  }
  if (documentTitle !== undefined) {
    contentOverrides.push('<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>')
    zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlText(documentTitle)}</dc:title></cp:coreProperties>`)
  }
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}${contentOverrides.join('')}</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>${documentTitle === undefined ? '' : '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'}</Relationships>`)
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds.join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRels.join('')}</Relationships>`)
  zip.file('ppt/theme/theme1.xml', PPTX_THEME)
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="titleAndBody"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`)
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`)
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  const saved = await commit('pptx', input.path, bytes, input.expectedHash, signal, MAX_PPTX_BYTES)
  return { ...saved, slides: prepared.length }
}

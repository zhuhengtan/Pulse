'use strict'

const { crc32, inflateRawSync } = require('node:zlib')
const { SaxesParser } = require('saxes')

const MAX_ENTRIES = 1_000
const MAX_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_RATIO = 10_000
const MAX_SLIDES = 2_000
const MAX_SLIDE_RANGE = 20

function fail(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function localName(name) {
  const text = typeof name === 'string' ? name : name && typeof name.name === 'string' ? name.name : ''
  const index = text.lastIndexOf(':')
  return index === -1 ? text : text.slice(index + 1)
}

function relationshipId(attributes) {
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (key.includes(':') && localName(key) === 'id') return String(value)
  }
  return undefined
}

function named(attributes, ...keys) {
  for (const key of keys) if (attributes?.[key] !== undefined) return String(attributes[key])
  return undefined
}

function assertNoDtd(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('XML_DTD_FORBIDDEN')
}

function parseEvents(xml, onOpen, onText, onClose, onCdata) {
  assertNoDtd(xml)
  const parser = new SaxesParser({ xmlns: false })
  let failed
  parser.on('error', (error) => { failed = error.code ? error : fail('INVALID_PPTX_XML') })
  parser.on('doctype', () => { failed = fail('XML_DTD_FORBIDDEN') })
  parser.on('opentag', (tag) => { if (!failed) onOpen(tag) })
  parser.on('text', (text) => { if (!failed && onText) onText(text) })
  parser.on('cdata', (text) => { if (!failed && onCdata) onCdata(text) })
  parser.on('closetag', (tag) => { if (!failed && onClose) onClose(tag) })
  parser.write(xml)
  parser.close()
  if (failed) throw failed
}

function entryName(raw, flags) {
  const name = raw.toString('utf8')
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw fail('OFFICE_ARCHIVE_PATH')
  if (name.split('/').includes('..')) throw fail('OFFICE_ARCHIVE_PATH')
  if (/vbaProject\.bin|vbaData\.xml|macrosheets/i.test(name)) throw fail('OFFICE_MACRO_FORBIDDEN')
  if ((flags & 0x800) === 0 && raw.includes(0)) throw fail('OFFICE_ARCHIVE_PATH')
  return name
}

function readOfficeArchive(data) {
  if (!Buffer.isBuffer(data) || data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) throw fail('INVALID_PPTX_ARCHIVE')
  const lowerBound = Math.max(0, data.length - 65_557)
  let eocd = -1
  for (let offset = data.length - 22; offset >= lowerBound; offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw fail('INVALID_PPTX_ARCHIVE')
  const disk = data.readUInt16LE(eocd + 4)
  const centralDisk = data.readUInt16LE(eocd + 6)
  const entriesOnDisk = data.readUInt16LE(eocd + 8)
  const entryCount = data.readUInt16LE(eocd + 10)
  const centralSize = data.readUInt32LE(eocd + 12)
  const centralOffset = data.readUInt32LE(eocd + 16)
  const commentLength = data.readUInt16LE(eocd + 20)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || entryCount > MAX_ENTRIES || eocd + 22 + commentLength > data.length || centralOffset + centralSize > eocd) throw fail('INVALID_PPTX_ARCHIVE')
  const files = new Map()
  let offset = centralOffset
  let totalUncompressed = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) throw fail('INVALID_PPTX_ARCHIVE')
    const flags = data.readUInt16LE(offset + 8)
    const compressionMethod = data.readUInt16LE(offset + 10)
    const expectedCrc = data.readUInt32LE(offset + 16)
    const compressed = data.readUInt32LE(offset + 20)
    const uncompressed = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const entryCommentLength = data.readUInt16LE(offset + 32)
    const localOffset = data.readUInt32LE(offset + 42)
    const entrySize = 46 + nameLength + extraLength + entryCommentLength
    if ((flags & 0x1) !== 0 || compressed === 0xffffffff || uncompressed === 0xffffffff || uncompressed > MAX_ENTRY_BYTES) throw fail('UNSUPPORTED_PPTX_ENTRY')
    if (offset + entrySize > data.length || (compressed > 0 && uncompressed / compressed > MAX_RATIO) || localOffset + 30 > centralOffset || data.readUInt32LE(localOffset) !== 0x04034b50) throw fail('INVALID_PPTX_ARCHIVE')
    const name = entryName(data.subarray(offset + 46, offset + 46 + nameLength), flags)
    if (files.has(name)) throw fail('OFFICE_ARCHIVE_DUPLICATE')
    const localNameLength = data.readUInt16LE(localOffset + 26)
    const localExtraLength = data.readUInt16LE(localOffset + 28)
    const contentOffset = localOffset + 30 + localNameLength + localExtraLength
    if (contentOffset + compressed > centralOffset || data.readUInt16LE(localOffset + 8) !== compressionMethod) throw fail('INVALID_PPTX_ARCHIVE')
    const compressedData = data.subarray(contentOffset, contentOffset + compressed)
    let inflated
    try {
      if (name.endsWith('/') && uncompressed === 0) inflated = Buffer.alloc(0)
      else if (compressionMethod === 0) inflated = Buffer.from(compressedData)
      else if (compressionMethod === 8) inflated = inflateRawSync(compressedData, { maxOutputLength: MAX_ENTRY_BYTES + 1 })
      else throw fail('UNSUPPORTED_PPTX_COMPRESSION')
    } catch (cause) {
      if (cause && cause.code) throw cause
      throw fail('INVALID_PPTX_ARCHIVE')
    }
    if (inflated.byteLength !== uncompressed || (crc32(inflated) >>> 0) !== expectedCrc) throw fail('OFFICE_ARCHIVE_CRC')
    totalUncompressed += inflated.byteLength
    if (totalUncompressed > MAX_TOTAL_BYTES) throw fail('PPTX_CONTENT_TOO_LARGE')
    files.set(name, inflated)
    offset += entrySize
  }
  if (offset !== centralOffset + centralSize) throw fail('INVALID_PPTX_ARCHIVE')
  return files
}

function normalizePart(baseDir, target) {
  if (target.includes('\0') || target.includes('\\') || target.startsWith('/') || /^[A-Za-z]:/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) throw fail('OFFICE_EXTERNAL_RELATIONSHIP')
  const parts = []
  for (const part of `${baseDir}/${target}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw fail('OFFICE_ARCHIVE_PATH')
      parts.pop()
      continue
    }
    parts.push(part)
  }
  if (parts.length === 0) throw fail('OFFICE_ARCHIVE_PATH')
  return parts.join('/')
}

function inspectRelationships(xml, baseDir, slides) {
  parseEvents(xml, (tag) => {
    if (localName(tag.name) !== 'Relationship') return
    const id = named(tag.attributes, 'Id', 'id')
    const type = named(tag.attributes, 'Type', 'type') ?? ''
    const target = named(tag.attributes, 'Target', 'target') ?? ''
    const mode = named(tag.attributes, 'TargetMode', 'targetMode') ?? ''
    const external = mode.toLowerCase() === 'external' || /^[a-z][a-z0-9+.-]*:/i.test(target)
    if (external) {
      if (!type.endsWith('/hyperlink')) throw fail('OFFICE_EXTERNAL_RELATIONSHIP')
      return
    }
    const path = normalizePart(baseDir, target)
    if (type.endsWith('/slide') && id) slides.set(id, path)
  })
}

function slideOrder(files) {
  const presentation = files.get('ppt/presentation.xml')
  const rels = files.get('ppt/_rels/presentation.xml.rels')
  if (!presentation || !rels) throw fail('INVALID_PPTX')
  const targets = new Map()
  inspectRelationships(rels.toString('utf8'), 'ppt', targets)
  for (const [name, bytes] of files) {
    if (!name.endsWith('.rels') || name === 'ppt/_rels/presentation.xml.rels') continue
    const marker = name.lastIndexOf('/_rels/')
    const base = name === '_rels/.rels' ? '' : marker < 0 ? undefined : name.slice(0, marker)
    if (base === undefined) throw fail('INVALID_PPTX')
    inspectRelationships(bytes.toString('utf8'), base, new Map())
  }
  const ids = []
  let inList = 0
  parseEvents(presentation.toString('utf8'), (tag) => {
    const name = localName(tag.name)
    if (name === 'sldIdLst') inList += 1
    if (inList > 0 && name === 'sldId') {
      const id = relationshipId(tag.attributes)
      if (!id) throw fail('INVALID_PPTX')
      ids.push(id)
    }
  }, undefined, (tag) => { if (localName(tag.name) === 'sldIdLst') inList -= 1 })
  if (ids.length > MAX_SLIDES) throw fail('PPTX_SLIDE_COUNT_TOO_LARGE')
  return ids.map((id) => {
    const path = targets.get(id)
    if (!path || !files.has(path)) throw fail('INVALID_PPTX')
    return path
  })
}

function highSurrogate(code) { return code >= 0xd800 && code <= 0xdbff }
function lowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff }

// Offset is a UTF-16 code-unit index. A window never starts or ends inside a surrogate pair.
function slideWindow(xml, skip, take) {
  let capture = false
  let text = ''
  const push = (chunk) => { if (chunk) text += chunk }
  parseEvents(xml, (tag) => { if (localName(tag.name) === 't') capture = true }, (value) => { if (capture) push(value) }, (tag) => {
    const name = localName(tag.name)
    if (name === 't') capture = false
    if (name === 'p' || name === 'br') push('\n')
  }, (value) => { if (capture) push(value) })
  if (skip > 0 && skip < text.length && lowSurrogate(text.charCodeAt(skip)) && highSurrogate(text.charCodeAt(skip - 1))) throw fail('INVALID_PPTX_OFFSET')
  let end = skip
  if (take > 0 && skip < text.length) {
    end = Math.min(text.length, skip + take)
    if (end > skip && end < text.length && highSurrogate(text.charCodeAt(end - 1)) && lowSurrogate(text.charCodeAt(end))) end += 1
  }
  return { text: text.slice(Math.min(skip, text.length), end), total: text.length }
}

function parsePptx(data, request) {
  const startSlide = request.startSlide ?? 1
  const offset = request.offset ?? 0
  const maxChars = request.maxChars
  if (!Number.isSafeInteger(startSlide) || startSlide < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 50_000) throw fail('INVALID_PPTX_RANGE')
  const files = readOfficeArchive(data)
  const slides = slideOrder(files)
  const totalSlides = slides.length
  if (totalSlides === 0) return { totalSlides: 0, startSlide: 1, endSlide: 0, text: '', truncated: false, nextSlide: null, nextOffset: null }
  const endSlide = request.endSlide ?? Math.min(totalSlides, startSlide + MAX_SLIDE_RANGE - 1)
  if (!Number.isSafeInteger(endSlide) || startSlide > totalSlides || endSlide > totalSlides || endSlide < startSlide) throw fail('INVALID_PPTX_SLIDE_RANGE')
  if (endSlide - startSlide + 1 > MAX_SLIDE_RANGE) throw fail('PPTX_SLIDE_RANGE_TOO_LARGE')
  const chunks = []
  let used = 0
  let truncated = false
  let nextSlide = endSlide < totalSlides ? endSlide + 1 : null
  let nextOffset = nextSlide === null ? null : 0
  let lastIncluded = startSlide - 1
  for (let number = startSlide; number <= endSlide; number++) {
    const xml = files.get(slides[number - 1]).toString('utf8')
    const skip = number === startSlide ? offset : 0
    const remaining = maxChars - used
    const window = slideWindow(xml, skip, Math.max(0, remaining))
    if (skip > window.total || (skip === window.total && window.total > 0)) throw fail('INVALID_PPTX_OFFSET')
    const body = remaining > 0 ? window.text : ''
    chunks.push(`--- Slide ${number} ---\n${body}`)
    used += body.length
    lastIncluded = number
    if (skip + body.length < window.total) {
      truncated = true
      nextSlide = number
      nextOffset = skip + body.length
      break
    }
    if (used >= maxChars && number < endSlide) {
      truncated = true
      nextSlide = number + 1
      nextOffset = 0
      break
    }
  }
  return { totalSlides, startSlide, endSlide: lastIncluded, text: chunks.join('\n\n'), truncated, nextSlide, nextOffset }
}

module.exports = { parsePptx, readOfficeArchive }

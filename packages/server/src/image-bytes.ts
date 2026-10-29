import { lstat, readFile } from 'node:fs/promises'
import { editingError } from './editing.js'

export const IMAGE_BASE64_LIMIT = 4 * 1024 * 1024
export const IMAGE_RAW_LIMIT = Math.floor(IMAGE_BASE64_LIMIT / 4) * 3
export const IMAGE_MAX_DIMENSION = 8192

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export async function readBoundedImage(path: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mediaType: 'image/png' | 'image/jpeg' }> {
  if (signal?.aborted) throw editingError('ABORTED', 'Image read aborted.')
  const stat = await lstat(path)
  if (!stat.isFile()) throw editingError('IMAGE_NOT_A_FILE', 'Only a regular PNG or JPEG file can be viewed.')
  if (stat.size > IMAGE_RAW_LIMIT) throw editingError('IMAGE_TOO_LARGE', `Image is ${stat.size} bytes; the limit is ${IMAGE_RAW_LIMIT} bytes.`)
  const bytes = await readFile(path, signal === undefined ? {} : { signal })
  if (bytes.length > IMAGE_RAW_LIMIT) throw editingError('IMAGE_TOO_LARGE', `Image is ${bytes.length} bytes; the limit is ${IMAGE_RAW_LIMIT} bytes.`)
  const mediaType = imageMediaType(bytes)
  assertImageDimensions(bytes, mediaType)
  if (bytes.toString('base64').length > IMAGE_BASE64_LIMIT) throw editingError('IMAGE_TOO_LARGE', 'Image exceeds the 4 MiB base64 limit.')
  return { bytes, mediaType }
}

function imageMediaType(bytes: Buffer): 'image/png' | 'image/jpeg' {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.subarray(12, 16).toString('ascii') === 'IHDR') return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && jpegSize(bytes)) return 'image/jpeg'
  throw editingError('UNSUPPORTED_IMAGE_FORMAT', 'Only PNG and JPEG images are supported for visual viewing.')
}

function assertImageDimensions(bytes: Buffer, mediaType: 'image/png' | 'image/jpeg'): void {
  const size = mediaType === 'image/png'
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : jpegSize(bytes)
  if (!size || size.width < 1 || size.height < 1 || size.width > IMAGE_MAX_DIMENSION || size.height > IMAGE_MAX_DIMENSION) {
    throw editingError('IMAGE_DIMENSIONS_INVALID', `Image dimensions must be between 1 and ${IMAGE_MAX_DIMENSION} pixels.`)
  }
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return undefined
    const marker = bytes[offset]!
    offset++
    if (marker === 0xd9 || marker === 0xda) return undefined
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 1 >= bytes.length) return undefined
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return undefined
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) return undefined
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return undefined
}

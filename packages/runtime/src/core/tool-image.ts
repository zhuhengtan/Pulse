import type { JsonValue } from './types.js'

/** Extract an explicit tool image before JSON history/result summarization. */
export function extractToolImage(value: JsonValue): { value: JsonValue; artifact?: { mediaType: string; content: Uint8Array } } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.pulseImage) return { value }
  const image = value.pulseImage
  if (typeof image !== 'object' || Array.isArray(image) || !['image/png', 'image/jpeg'].includes(String(image.mediaType)) || typeof image.data !== 'string' || image.data.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('INVALID_TOOL_IMAGE')
  const bytes = Buffer.from(image.data, 'base64')
  if (bytes.length < 16 || (image.mediaType === 'image/png' ? bytes.readUInt32BE(0) !== 0x89504e47 : bytes.readUInt16BE(0) !== 0xffd8)) throw new Error('INVALID_TOOL_IMAGE')
  const { pulseImage: _image, ...metadata } = value
  return { value: metadata, artifact: { mediaType: image.mediaType as string, content: bytes } }
}

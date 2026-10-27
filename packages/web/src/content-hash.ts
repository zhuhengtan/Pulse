const ROUNDS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits))
/** SHA-256 of the exact UTF-8 bytes. This matches the server hash where SubtleCrypto is unavailable. */
export function sha256Hex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6
  const data = new Uint8Array(paddedLength)
  data.set(bytes)
  data[bytes.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const earlier = words[index - 15]!
      const recent = words[index - 2]!
      const small = (rotate(earlier, 7) ^ rotate(earlier, 18) ^ (earlier >>> 3)) >>> 0
      const large = (rotate(recent, 17) ^ rotate(recent, 19) ^ (recent >>> 10)) >>> 0
      words[index] = (words[index - 16]! + small + words[index - 7]! + large) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let index = 0; index < 64; index += 1) {
      const upper = (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) >>> 0
      const choice = ((e & f) ^ (~e & g)) >>> 0
      const first = (h + upper + choice + ROUNDS[index]! + words[index]!) >>> 0
      const lower = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) >>> 0
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const second = (lower + majority) >>> 0
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(value => value.toString(16).padStart(8, '0')).join('')
}
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes)
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    } catch { /* A non-secure HTTP origin does not expose SubtleCrypto. */ }
  }
  return sha256Hex(bytes)
}

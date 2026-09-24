import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemTool } from '../packages/adapters/src/tools/filesystem.js'

describe('source line windows', () => {
  it('resolves UTF-8 and CRLF lines to actual byte offsets, including EOF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulse-lines-'))
    try {
      const text = '中文\r\n' + 'x'.repeat(65532) + '\n目标\n'
      await writeFile(join(dir, 'source.txt'), text)
      const fs = new FilesystemTool(dir)
      expect(await fs.offsetForLine('source.txt', 1)).toBe(0)
      expect(await fs.offsetForLine('source.txt', 2)).toBe(Buffer.byteLength('中文\r\n'))
      const offset = await fs.offsetForLine('source.txt', 3)
      expect((await fs.readRange('source.txt', 100, offset)).content).toBe('目标\n')
      expect(await fs.offsetForLine('source.txt', 99)).toBe(Buffer.byteLength(text))
      await expect(fs.offsetForLine('source.txt', 0)).rejects.toThrow('INVALID_START_LINE')
      const controller = new AbortController(); controller.abort()
      await expect(fs.offsetForLine('source.txt', 1, controller.signal)).rejects.toThrow('ABORTED')
      await writeFile(join(dir, 'large.txt'), Buffer.alloc(16 * 1024 * 1024 + 1, 120))
      await expect(fs.offsetForLine('large.txt', 2)).rejects.toThrow('READ_LINE_SCAN_LIMIT')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchFiles, searchWorkspace } from '../packages/server/src/security.js'

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

describe('workspace search behavior', () => {
  it('matches a selected file and its containing directory consistently with accurate line numbers', async () => {
    const directory = await tempDir('pulse-search-single-')
    try {
      await writeFile(join(directory, 'notes.txt'), 'first\nNeedle here\nlast\n')
      const file = await searchFiles(directory, 'NEEDLE', 'notes.txt')
      const tree = await searchFiles(directory, 'NEEDLE', '.')
      expect(file).toEqual([{ path: 'notes.txt', line: 2, text: 'Needle here' }])
      expect(tree).toEqual(file)
      expect((await searchWorkspace(directory, 'needle')).matches).toEqual(file)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('skips a file larger than the read budget instead of reading it whole', async () => {
    const directory = await tempDir('pulse-search-large-')
    try {
      await writeFile(join(directory, 'small.txt'), 'needle\n')
      const big = Buffer.alloc(1_000_001, 0x61)
      big.write('needle', 0, 'utf8')
      await writeFile(join(directory, 'big.txt'), big)
      expect(await searchFiles(directory, 'needle')).toEqual([{ path: 'small.txt', line: 1, text: 'needle' }])
      expect(await searchFiles(directory, 'needle', 'big.txt')).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('skips binary files that contain a NUL byte', async () => {
    const directory = await tempDir('pulse-search-binary-')
    try {
      await writeFile(join(directory, 'bin.dat'), 'needle\u0000tail\n')
      await writeFile(join(directory, 'text.txt'), 'needle\n')
      expect(await searchFiles(directory, 'needle')).toEqual([{ path: 'text.txt', line: 1, text: 'needle' }])
      expect(await searchFiles(directory, 'needle', 'bin.dat')).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not follow a symlink that escapes the workspace', async () => {
    const directory = await tempDir('pulse-search-symlink-')
    const outside = await tempDir('pulse-search-outside-')
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret-value\n')
      await symlink(outside, join(directory, 'escape'))
      expect(await searchFiles(directory, 'secret-value')).toEqual([])
      // The security boundary rejects a symlink that escapes the workspace
      // instead of silently returning no matches.
      await expect(searchFiles(directory, 'secret-value', 'escape')).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('reports result-limit truncation instead of a silent empty result', async () => {
    const directory = await tempDir('pulse-search-results-')
    try {
      await writeFile(join(directory, 'many.txt'), Array.from({ length: 150 }, () => 'needle').join('\n'))
      const result = await searchWorkspace(directory, 'needle')
      expect(result.matches).toHaveLength(100)
      expect(result.truncated).toBe(true)
      expect(result.reason).toBe('results')
      expect(result.matched).toBe(100)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports visit-limit truncation for a directory larger than the visit budget', async () => {
    const directory = await tempDir('pulse-search-visited-')
    try {
      for (let index = 0; index < 2_001; index += 1) await writeFile(join(directory, `f${index}.txt`), 'nothing\n')
      const result = await searchWorkspace(directory, 'needle')
      expect(result.truncated).toBe(true)
      expect(result.reason).toBe('visited')
      expect(result.matches).toEqual([])
      expect(result.visited).toBe(2_000)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports depth-limit truncation for deeply nested directories', async () => {
    const directory = await tempDir('pulse-search-depth-')
    try {
      const segments = Array.from({ length: 10 }, (_, index) => `d${index}`)
      await mkdir(join(directory, ...segments), { recursive: true })
      await writeFile(join(directory, ...segments, 'deep.txt'), 'needle\n')
      const result = await searchWorkspace(directory, 'needle')
      expect(result.matches).toEqual([])
      expect(result.truncated).toBe(true)
      expect(result.reason).toBe('depth')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('throws a clear error instead of returning empty results when the signal is aborted', async () => {
    const directory = await tempDir('pulse-search-abort-')
    try {
      await writeFile(join(directory, 'notes.txt'), 'needle\n')
      const controller = new AbortController()
      controller.abort()
      await expect(searchWorkspace(directory, 'needle', '.', controller.signal)).rejects.toThrow('SEARCH_ABORTED')
      await expect(searchFiles(directory, 'needle', '.', 0, { count: 0 }, { count: 0 }, controller.signal)).rejects.toThrow('SEARCH_ABORTED')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

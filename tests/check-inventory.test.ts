import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { it, expect } from 'vitest'
import { captureCheck, finishCheck, assertCheckEdit } from '../packages/server/src/check-receipt.js'

it('freezes tracked and new checks without scanning ignored historical runtime data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-check-inventory-'))
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root })
  try {
    await git(['init', '--quiet'])
    await mkdir(join(root, 'tests'))
    await writeFile(join(root, 'tests', 'original.test.ts'), 'it("original", () => {})')
    await git(['add', 'tests/original.test.ts'])
    await writeFile(join(root, '.gitignore'), 'tests/runs/\ntests/original.test.ts\n')
    await mkdir(join(root, 'tests', 'runs'))
    await writeFile(join(root, 'tests', 'runs', 'runtime.ts'), 'x'.repeat(1_000_001))
    await writeFile(join(root, 'tests', 'new.test.ts'), 'it("new", () => {})')
    const receipt = await captureCheck(root, root, 'node', ['--test'], true)
    expect(receipt.definitions).toHaveProperty('tests/original.test.ts')
    expect(receipt.definitions).toHaveProperty('tests/new.test.ts')
    expect(receipt.files).not.toHaveProperty('tests/runs/runtime.ts')
    const legacy = structuredClone(receipt)
    for (const field of ['files', 'definitions'] as const) legacy[field] = Object.fromEntries(Object.entries(legacy[field]).map(([key, value]) => [key.replaceAll('/', '\\'), value]))
    expect((await finishCheck(root, legacy)).stable).toBe(true)
    const store = join(root, 'data'); await mkdir(store)
    await writeFile(join(store, 'original.json'), JSON.stringify({ 'tests\\original.test.ts': receipt.definitions['tests/original.test.ts'] }))
    await expect(assertCheckEdit(root, store, 'tests/original.test.ts', 'broken')).rejects.toThrow('FROZEN_TEST_CHANGE')
    await expect(captureCheck(root, root, 'node', ['tests/runs/runtime.ts'])).rejects.toThrow('Check input exceeds')
  } finally { await rm(root, { recursive: true, force: true }) }
})

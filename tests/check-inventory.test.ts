import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { it, expect } from 'vitest'
import { captureCheck } from '../packages/server/src/check-receipt.js'

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
    await expect(captureCheck(root, root, 'node', ['tests/runs/runtime.ts'])).rejects.toThrow('Check input exceeds')
  } finally { await rm(root, { recursive: true, force: true }) }
})

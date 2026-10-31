import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ciVitestArgs, ciVitestEntry } from '../scripts/ci/test.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))

it('starts the installed Vitest with the current Node and does not launch a package manager', async () => {
  const entry = ciVitestEntry(repo)
  expect(entry.command).toBe(process.execPath)
  expect(entry.script).toBe(join(repo, 'node_modules', 'vitest', 'vitest.mjs'))
  expect(entry.args).toEqual(ciVitestArgs)
  expect(entry.args).toEqual(['run', '--exclude', 'tests/live/**', '--maxWorkers=2', '--minWorkers=1'])
  await access(entry.script)
  const source = await readFile(join(repo, 'scripts', 'ci', 'test.mjs'), 'utf8')
  expect(source).toContain('process.execPath')
  expect(source).toContain('VITEST_NOT_INSTALLED')
  expect(source).not.toMatch(/\b(?:pnpm|npm|npx|corepack|uvx)\b/)
  expect(source).not.toContain('shell:')
})

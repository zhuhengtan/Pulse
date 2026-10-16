import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isNecessaryVerification } from '../packages/server/src/verification-policy.js'

describe('necessary workspace verification', () => {
  let root: string
  let outside: string
  const intent = '修复项目代码并验证测试'
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pulse-verification-'))
    outside = await mkdtemp(join(tmpdir(), 'pulse-outside-'))
    await mkdir(join(root, 'src')); await mkdir(join(root, 'tests'))
    await writeFile(join(root, 'src/main.mjs'), 'export const ok = true')
    await writeFile(join(root, 'tests/main.test.ts'), '')
    await writeFile(join(root, 'tests/main.test.js'), '')
    await writeFile(join(outside, 'outside.test.js'), '')
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: "vitest run --exclude 'tests/live/**'", typecheck: 'tsc --noEmit' } }))
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })

  it.each([
    ['node', ['--version']], ['pnpm', ['--version']],
    ['grep', ['-n', '--', 'export', 'src/main.mjs']],
    ['rg', ['-n', '-e', 'export', 'src/main.mjs']],
    ['git', ['status', '--short', '--branch']],
    ['node', ['--check', 'src/main.mjs']],
    ['node', ['--test', 'tests/main.test.js']],
    ['pnpm', ['exec', 'vitest', 'run', 'tests/main.test.ts']],
    ['pnpm', ['exec', 'tsc', '--noEmit']],
    ['pnpm', ['test']], ['npm', ['test']], ['pnpm', ['run', 'typecheck']],
  ])('admits bounded %s %j', async (command, args) => {
    expect(await isNecessaryVerification(root, { command, args }, intent)).toBe(true)
  })
  it.each([
    ['grep', ['-f', 'src/main.mjs', 'src/main.mjs']],
    ['rg', ['-n', 'x', 'linked/outside.test.js']],
    ['grep', ['-n', 'x', '../.env']],
    ['git', ['status', '--short', '--untracked-files=all']],
    ['git', ['reset', '--hard']],
    ['node', ['-e', 'console.log(1)']], ['node', ['--eval', '1']],
    ['node', ['--check', '--require', 'src/main.mjs']],
    ['node', ['--test', '--import', 'src/main.mjs']],
    ['node', ['--test', 'src/main.mjs']],
    ['node', ['--check', 'linked/outside.test.js']],
    ['node', ['--check', 'missing.mjs']],
    ['node --check', ['src/main.mjs']],
    ['/tmp/node', ['--check', 'src/main.mjs']],
    ['pnpm', ['exec', 'vitest', 'run', 'tests/main.test.ts', '--update']],
    ['pnpm', ['exec', 'vitest', 'run', '--config', 'src/main.mjs']],
    ['pnpm', ['test', '&&', 'rm', '-rf', '.']],
    ['npm', ['exec', 'arbitrary-package']],
  ])('retains review for %s %j', async (command, args) => {
    expect(await isNecessaryVerification(root, { command, args }, intent)).toBe(false)
  })
  it('requires an authorized coding/check task and an in-workspace cwd', async () => {
    const input = { command: 'node', args: ['--check', 'src/main.mjs'] }
    expect(await isNecessaryVerification(root, input, '讲一个笑话')).toBe(false)
    expect(await isNecessaryVerification(root, input, 'latest news')).toBe(false)
    expect(await isNecessaryVerification(root, input, 'Explain how to test the code')).toBe(false)
    expect(await isNecessaryVerification(root, input, '只需要分析，不要运行测试')).toBe(false)
    expect(await isNecessaryVerification(root, { ...input, cwd: outside }, intent)).toBe(false)
    expect(await isNecessaryVerification(root, input, JSON.stringify({ currentRequest: '继续', recentConversation: [{ role: 'user', content: intent }] }))).toBe(true)
    expect(await isNecessaryVerification(root, input, JSON.stringify({ currentRequest: '继续', recentConversation: [{ role: 'assistant', content: intent }] }))).toBe(false)
  })
  it('does not approve shell/lifecycle commands merely because the script is named test', async () => {
    for (const scripts of [{ test: 'node -e "doAnything()"' }, { test: 'vitest run && curl example.com' }, { test: 'vitest run', pretest: 'node scripts/setup.js' }, { test: 'node --test tests/../../outside.test.js' }]) {
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }))
      expect(await isNecessaryVerification(root, { command: 'pnpm', args: ['test'] }, intent)).toBe(false)
    }
  })
})

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
    await writeFile(join(root, '.env'), 'fixture=private')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git/config'), 'fixture')
    await symlink(join(root, 'src/main.mjs'), join(root, '.env.test'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: "vitest run --exclude 'tests/live/**'", typecheck: 'tsc --noEmit' } }))
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })

  it.each([
    ['node', ['--version']], ['pnpm', ['--version']],
    ['grep', ['-n', '--', 'export', 'src/main.mjs']],
    ['rg', ['-n', '-e', 'export', 'src/main.mjs']],
    ['git', ['status', '--short', '--branch']],
    ['wc', ['-l', 'src/main.mjs']],
    ['wc', ['-l', 'src/main.mjs', 'tests/main.test.js']],
    ['cat', ['src/main.mjs']], ['cat', ['-n', 'src/main.mjs', 'tests/main.test.js']],
    ['node', ['--check', 'src/main.mjs']],
    ['node', ['--test', 'tests/main.test.js']],
    ['node', ['--test', '--test-name-pattern=report totals agree', '--test-reporter=spec', 'tests/main.test.js']],
    ['node', ['--test', '--test-name-pattern', 'report totals agree', '--test-reporter', 'tap', 'tests/main.test.js']],
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
    ['node', ['--test', '--test-reporter=./src/main.mjs', 'tests/main.test.js']],
    ['node', ['--test', '--test-reporter-destination=output.txt', 'tests/main.test.js']],
    ['node', ['--test', '--test-name-pattern=']],
    ['node', ['--test', '--test-name-pattern', '--import', 'tests/main.test.js']],
    ['node', ['--test', '--test-name-pattern=x', '--test-name-pattern=y', 'tests/main.test.js']],
    ['node', ['--test', 'tests/main.test.js', '--test-reporter=spec']],
    ['node', ['--test', '--test-reporter=spec']],
    ['node', ['--test', 'src/main.mjs']],
    ['node', ['--check', 'linked/outside.test.js']],
    ['node', ['--check', 'missing.mjs']],
    ['node --check', ['src/main.mjs']],
    ['/tmp/node', ['--check', 'src/main.mjs']],
    ['pnpm', ['exec', 'vitest', 'run', 'tests/main.test.ts', '--update']],
    ['pnpm', ['exec', 'vitest', 'run', '--config', 'src/main.mjs']],
    ['pnpm', ['test', '&&', 'rm', '-rf', '.']],
    ['npm', ['exec', 'arbitrary-package']],
    ['wc', []], ['wc', ['-l']], ['wc', ['-l', '-']],
    ['wc', ['-c', 'src/main.mjs']], ['wc', ['-lw', 'src/main.mjs']],
    ['wc', ['-l', '--files0-from=src/main.mjs']],
    ['wc', ['-l', 'src/main.mjs', '--version']],
    ['wc', ['-l', 'src/*.mjs']], ['wc', ['-l', 'src']],
    ['wc', ['-l', 'missing.mjs']], ['wc', ['-l', '.env']],
    ['wc', ['-l', '.git/config']], ['wc', ['-l', '.env.test']],
    ['wc', ['-l', 'linked/outside.test.js']],
    ['wc', ['-l', 'src/main.mjs', '&&', 'id']],
    ['wc', ['-l', 'src/main.mjs\nother']],
    ['/tmp/wc', ['-l', 'src/main.mjs']],
    ['wc -l', ['src/main.mjs']],
    ['cat', []], ['cat', ['-n']], ['cat', ['-']], ['cat', ['-n', '-']],
    ['cat', ['--number', 'src/main.mjs']], ['cat', ['src/main.mjs', '--version']],
    ['cat', ['src/*.mjs']], ['cat', ['src']], ['cat', ['missing.mjs']],
    ['cat', ['.env']], ['cat', ['.env.test']], ['cat', ['.git/config']],
    ['cat', ['linked/outside.test.js']], ['cat', ['src/main.mjs', '>', 'other.mjs']],
    ['/tmp/cat', ['src/main.mjs']], ['cat -n', ['src/main.mjs']],
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
  it('bounds line counting to ordinary in-workspace files and authorized tasks', async () => {
    const input = { command: 'wc', args: ['-l', 'main.mjs'], cwd: join(root, 'src') }
    expect(await isNecessaryVerification(root, input, intent)).toBe(true)
    expect(await isNecessaryVerification(root, { command: 'wc', args: ['-l', join(root, 'src/main.mjs')] }, intent)).toBe(true)
    expect(await isNecessaryVerification(root, input, '只分析，不要执行任何命令')).toBe(false)
    expect(await isNecessaryVerification(root, { ...input, cwd: outside }, intent)).toBe(false)
    expect(await isNecessaryVerification(root, { command: 'wc', args: ['-l', join(outside, 'outside.test.js')] }, intent)).toBe(false)
    expect(await isNecessaryVerification(root, { command: 'wc', args: ['-l', ...Array(33).fill('src/main.mjs')] }, intent)).toBe(false)
  })
  it.each([
    '请清洗并分析原始日志，编写可复现脚本并立即运行产出报表。',
    '创建一个程序，把表格转成 JSON。',
    '运行数据处理脚本并生成统计结果。',
    'Write a Python script to reconcile the records and produce a report.',
    'Create a reproducible script for log analysis.',
    'Run the normalization script and save its output.',
  ])('admits bounded verification for explicit script tasks: %s', async request => {
    const input = { command: 'node', args: ['--test', 'tests/main.test.js'] }
    expect(await isNecessaryVerification(root, input, request)).toBe(true)
    expect(await isNecessaryVerification(root, { command: 'wc', args: ['-l', 'src/main.mjs'] }, request)).toBe(true)
    expect(await isNecessaryVerification(root, input, JSON.stringify({ currentRequest: '继续', recentConversation: [{ role: 'user', content: request }] }))).toBe(true)
    // Script authorization does not admit arbitrary execution or sensitive reads.
    expect(await isNecessaryVerification(root, { command: 'node', args: ['src/main.mjs'] }, request)).toBe(false)
    expect(await isNecessaryVerification(root, { command: 'wc', args: ['-l', '.env'] }, request)).toBe(false)
    expect(await isNecessaryVerification(root, { ...input, cwd: outside }, request)).toBe(false)
  })
  it.each([
    '清洗数据有什么方法？', '分析日志中的问题', '这个脚本用途是什么？',
    '只分析脚本，不要执行', '仅分析如何编写脚本', '编写脚本但不运行',
    '创建脚本，无需执行测试', '运行脚本的方案，仅阅读和解释',
    'Explain how to write a script.', 'Write a script but do not run it.',
    "Create a script but don't test or execute it.", 'Only analyze the script.',
  ])('retains review for discussion or explicitly restricted script tasks: %s', async request => {
    const input = { command: 'node', args: ['--test', 'tests/main.test.js'] }
    expect(await isNecessaryVerification(root, input, request)).toBe(false)
    expect(await isNecessaryVerification(root, input, JSON.stringify({ currentRequest: '继续', recentConversation: [{ role: 'user', content: request }] }))).toBe(false)
  })
  it('does not inherit script authority from an assistant or override current restrictions', async () => {
    const input = { command: 'node', args: ['--test', 'tests/main.test.js'] }
    const history = [{ role: 'user', content: '编写数据整理脚本并运行。' }]
    expect(await isNecessaryVerification(root, input, JSON.stringify({ currentRequest: '继续，只分析不要运行', recentConversation: history }))).toBe(false)
    expect(await isNecessaryVerification(root, input, JSON.stringify({ currentRequest: '继续', recentConversation: [{ ...history[0], role: 'assistant' }] }))).toBe(false)
  })
  it('bounds ordinary file reads by size, cwd, count and task authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-bounded-cat-'))
    try {
      await mkdir(join(directory, 'data'))
      await writeFile(join(directory, 'data/one.jsonl'), 'x'.repeat(32_768))
      await writeFile(join(directory, 'data/two.jsonl'), 'x'.repeat(32_769))
      const input = { command: 'cat', args: ['-n', 'one.jsonl'], cwd: join(directory, 'data') }
      const task = '编写并运行数据处理脚本。'
      expect(await isNecessaryVerification(directory, input, task)).toBe(true)
      expect(await isNecessaryVerification(directory, { command: 'cat', args: ['data/one.jsonl', 'data/two.jsonl'] }, task)).toBe(false)
      expect(await isNecessaryVerification(directory, { ...input, cwd: outside }, task)).toBe(false)
      expect(await isNecessaryVerification(directory, input, '仅分析，不要运行')).toBe(false)
      expect(await isNecessaryVerification(directory, { command: 'cat', args: Array(33).fill('data/one.jsonl') }, task)).toBe(false)
      await symlink(join(directory, 'data'), join(directory, '.env.alias'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(await isNecessaryVerification(directory, { command: 'cat', args: ['.env.alias/one.jsonl'] }, task)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('does not approve shell/lifecycle commands merely because the script is named test', async () => {
    for (const scripts of [{ test: 'node -e "doAnything()"' }, { test: 'vitest run && curl example.com' }, { test: 'vitest run', pretest: 'node scripts/setup.js' }, { test: 'node --test tests/../../outside.test.js' }]) {
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }))
      expect(await isNecessaryVerification(root, { command: 'pnpm', args: ['test'] }, intent)).toBe(false)
    }
  })
  it('recognizes direct default Node test discovery only for the exact declared test entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-node-test-entry-'))
    try {
      const input = { command: 'node', args: ['--test'] }
      for (const scripts of [{ test: 'vitest run' }, { test: 'node --test', pretest: 'node setup.js' }, { test: 'node --test', posttest: 'node cleanup.js' }]) {
        await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts }))
        expect(await isNecessaryVerification(directory, input, intent)).toBe(false)
      }
      await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
      expect(await isNecessaryVerification(directory, input, intent)).toBe(true)
      await mkdir(join(directory, 'test'))
      await writeFile(join(directory, 'test/feature.test.mjs'), "import test from 'node:test'\ntest('feature', () => {})\n")
      await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/feature.test.mjs' } }))
      expect(await isNecessaryVerification(directory, input, intent)).toBe(true)
      expect(await isNecessaryVerification(directory, { command: 'npm', args: ['test'] }, intent)).toBe(true)
      await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test --import ./test/feature.test.mjs' } }))
      expect(await isNecessaryVerification(directory, input, intent)).toBe(false)
      await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/../../outside.test.mjs' } }))
      expect(await isNecessaryVerification(directory, input, intent)).toBe(false)
      await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/feature.test.mjs' } }))
      expect(await isNecessaryVerification(directory, input, '只分析，不要运行测试')).toBe(false)
      expect(await isNecessaryVerification(directory, { command: 'node', args: ['--input-type=module', '-e', "import assert from 'node:assert/strict'; assert.equal(1, 1)"] }, intent)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('recognizes simple declared Node test globs without admitting hooks, escapes or unrelated files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-node-test-glob-'))
    try {
      await mkdir(join(directory, 'test'))
      await writeFile(join(directory, 'test/one.test.mjs'), '')
      await writeFile(join(directory, 'test/two.test.mjs'), '')
      const check = async (script: string, extra = {}) => {
        await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: script, ...extra } }))
        return Promise.all([
          isNecessaryVerification(directory, { command: 'node', args: ['--test'] }, intent),
          isNecessaryVerification(directory, { command: 'npm', args: ['test'] }, intent),
        ])
      }
      expect(await check('node --test test/*.test.mjs')).toEqual([true, true])
      for (const script of ['node --test test/none*.test.mjs', 'node --test test/**/*.test.mjs', 'node --test test/[ot]*.test.mjs', 'node --test test/*', 'node --test ../*.test.mjs', 'node --test --import test/one.test.mjs', 'node --test test/*.test.mjs && id']) {
        expect(await check(script)).toEqual([false, false])
      }
      expect(await check('node --test test/*.test.mjs', { pretest: 'node setup.mjs' })).toEqual([false, false])
      await symlink(join(outside, 'outside.test.js'), join(directory, 'test/linked.test.mjs'))
      expect(await check('node --test test/*.test.mjs')).toEqual([false, false])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

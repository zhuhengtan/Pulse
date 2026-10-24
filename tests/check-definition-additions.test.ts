import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { assertCheckEdit, candidateTestChangesAllowed, captureCheck, finishCheck, freezeCheckDefinitions, testAdditionsRequested } from '../packages/server/src/check-receipt.js'
import { requiredArgumentChecks } from '../packages/server/src/task-controller/acceptance.js'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { ExactPatchEditor } from '../packages/server/src/editing.js'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { staleFileEvidence } from '../packages/server/src/task-controller/evidence-current.js'

describe('authorized test additions and independent check scope', () => {
  it.each([false, true])('permits only unchanged-prefix test extensions when authorized=%s', async (authorized) => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-extend-tests-'))
    const store = join(root, 'data')
    const path = join(root, 'test/feature.test.mjs')
    const original = "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('baseline', () => assert.equal(1, 1))\n"
    const capture = async () => finishCheck(root, await captureCheck(root, root, 'node', ['--test', 'test/feature.test.mjs']), store)
    try {
      await mkdir(join(root, 'test'))
      await writeFile(path, original)
      await freezeCheckDefinitions(root, store, authorized)
      await writeFile(path, original + "\ntest('new behavior', () => assert.equal(2, 2))\n")
      expect((await capture()).definitionChanged).toBe(!authorized)
      await writeFile(path, original + "\ntest('another case', () => assert.equal(3, 3))\n")
      expect((await capture()).definitionChanged).toBe(!authorized)
      await writeFile(path, original + "\nimport './hook.mjs'\n")
      expect((await capture()).definitionChanged).toBe(true)
      await writeFile(path, original + "\nassert.equal = () => {}\n")
      expect((await capture()).definitionChanged).toBe(true)
      await writeFile(path, original.replace("import assert from 'node:assert/strict'\n", "import assert from 'node:assert/strict'\nimport http from 'node:http'\n") + "\ntest('added', () => assert.equal(2, 2))\n")
      expect((await capture()).definitionChanged).toBe(true)
      await writeFile(path, original.replace('assert.equal(1, 1)', 'assert.equal(1, 2)'))
      expect((await capture()).definitionChanged).toBe(true)
      await writeFile(path, "process.exit(0)\n")
      expect((await capture()).definitionChanged).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([
    { authorized: true, destructive: true, atomic: false },
    { authorized: true, destructive: true, atomic: true },
    { authorized: true, destructive: false, atomic: false },
    { authorized: false, destructive: false, atomic: false },
  ])('rejects frozen baseline destruction before patch commit (%j)', async ({ authorized, destructive, atomic }) => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-test-preflight-'))
    const store = join(root, 'data'), path = 'test/feature.test.mjs'
    const original = "import test from 'node:test'\nimport assert from 'node:assert/strict'\n\ntest('placeholder', () => assert.equal(1, 1))\n"
    try {
      await mkdir(join(root, 'test'))
      await writeFile(join(root, path), original)
      await freezeCheckDefinitions(root, store, authorized)
      const editor = new ExactPatchEditor(new FilesystemTool(root), (file, proposed) => assertCheckEdit(root, store, file, proposed))
      const patches = destructive
        ? [{ find: "test('placeholder', () => assert.equal(1, 1))", replace: "test('real check', () => assert.equal(2, 2))" }, ...(atomic ? [{ find: "import assert from 'node:assert/strict'", replace: "import assert from 'node:assert/strict'\nimport fs from 'node:fs'" }] : [])]
        : [{ find: original.trimEnd(), replace: original.trimEnd() + "\ntest('new case', () => assert.equal(2, 2))" }]
      if (!authorized || destructive) {
        await expect(editor.execute({ path, patches })).rejects.toMatchObject({ code: 'FROZEN_TEST_CHANGE' })
        expect(await readFile(join(root, path), 'utf8')).toBe(original)
      } else {
        await expect(editor.execute({ path, patches })).resolves.toMatchObject({ changed: true })
        expect((await finishCheck(root, await captureCheck(root, root, 'node', ['--test', path]), store)).definitionChanged).toBe(false)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([false, true])('allows iterating only newly generated verification scripts (preexisting=%s)', async preexisting => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-candidate-check-script-'))
    const store = join(root, 'data'), path = 'scripts/verify-feature.mjs'
    try {
      await mkdir(join(root, 'scripts'))
      if (preexisting) await writeFile(join(root, path), 'process.exitCode = 1\n')
      await freezeCheckDefinitions(root, store, false, true)
      if (!preexisting) await writeFile(join(root, path), 'process.exitCode = 1\n')
      await finishCheck(root, await captureCheck(root, root, 'node', [path]), store)
      await writeFile(join(root, path), "import assert from 'node:assert/strict'\nassert.equal(2 + 2, 4)\n")
      const current = await finishCheck(root, await captureCheck(root, root, 'node', [path]), store)
      expect(current.definitionChanged).toBe(preexisting)
      expect(current.stable).toBe(true)
      await writeFile(join(root, path), 'process.exitCode = 2\n')
      const fresh = await captureCheck(root, root, 'node', [path])
      await writeFile(join(root, path), 'process.exitCode = 3\n')
      expect((await finishCheck(root, fresh, store)).stable).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refreshes historical file versions from a passed sibling without masking failed checks or external changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-sibling-snapshot-'))
    try {
      const runtime = new PulseRuntime(), digest = (value: string) => createHash('sha256').update(value).digest('hex')
      for (const [ref, content] of [['result-1', 'old'], ['result-2', 'updated']]) {
        runtime.state.effects.set(ref!, { id: ref, outcome: { status: 'succeeded' } } as any)
        runtime.state.results.set(ref!, { id: ref, producer: { kind: 'effect', id: ref }, privacy: 'public', derivedFrom: [], value: { path: 'shared.mjs', hash: digest(content!) } } as any)
      }
      await writeFile(join(root, 'shared.mjs'), 'updated')
      expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual(['result-1'])
      expect(await staleFileEvidence(root, ['result-1'], runtime, undefined, ['result-2'])).toEqual([])
      runtime.state.effects.get('result-2')!.outcome = { status: 'failed', error: { code: 'FAILED', message: 'not written', retryable: false } }
      expect(await staleFileEvidence(root, ['result-1'], runtime, undefined, ['result-2'])).toEqual(['result-1'])
      runtime.state.effects.get('result-2')!.outcome = { status: 'succeeded' }
      runtime.state.results.set('result-3', { id: 'result-3', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: { stable: true, definitionChanged: true, files: {}, command: 'node', args: ['--test'], cwd: '.' } } } as any)
      expect(await staleFileEvidence(root, ['result-1', 'result-3'], runtime, undefined, ['result-2'])).toEqual(['result-3'])
      await writeFile(join(root, 'shared.mjs'), 'external')
      expect(await staleFileEvidence(root, ['result-1'], runtime, undefined, ['result-2'])).toEqual(['result-1', 'result-2'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses a later full behavioral check instead of stale syntax evidence while detecting subsequent changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-fresh-check-'))
    try {
      await writeFile(join(root, 'feature.mjs'), 'export const value = 1\n')
      await writeFile(join(root, 'feature.test.mjs'), "import { value } from './feature.mjs'\n")
      const old = await captureCheck(root, root, 'node', ['--check', 'feature.mjs'])
      await writeFile(join(root, 'feature.mjs'), 'export const value = 2\n')
      const updated = await captureCheck(root, root, 'node', ['--test', 'feature.test.mjs'])
      const runtime = new PulseRuntime()
      runtime.state.results.set('result-1', { id: 'result-1', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: old as any } })
      runtime.state.results.set('result-2', { id: 'result-2', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: updated as any } })
      expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime)).toEqual([])
      runtime.state.results.get('result-2')!.value = { code: 1, checkReceipt: updated as any }
      expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime)).toContain('result-1')
      runtime.state.results.get('result-2')!.value = { code: 0, checkReceipt: { ...updated, args: ['--check', 'feature.test.mjs'] } as any }
      expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime)).toContain('result-1')
      runtime.state.results.get('result-2')!.value = { code: 0, checkReceipt: { ...updated, args: ['--test', '--test-name-pattern', 'subset'] } as any }
      expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime)).toContain('result-1')
      runtime.state.results.get('result-2')!.value = { code: 0, checkReceipt: updated as any }
      runtime.state.results.set('result-3', { id: 'result-3', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: { ...old, args: ['--test', 'feature.test.mjs'] } as any } })
      runtime.state.results.set('result-4', { id: 'result-4', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: { ...updated, args: ['--test'] } as any } })
      expect(await staleFileEvidence(root, ['result-3', 'result-4'], runtime)).toEqual([])
      await writeFile(join(root, 'feature.mjs'), 'external mutation\n')
      expect(await staleFileEvidence(root, ['result-1', 'result-2'], runtime)).toContain('result-2')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('requires explicit test-addition intent and respects negative instructions', () => {
    expect(testAdditionsRequested('补充并通过 test/service.test.mjs 自动化测试。')).toBe(true)
    expect(testAdditionsRequested('Implement the feature and add regression tests.')).toBe(true)
    expect(testAdditionsRequested('Run existing tests')).toBe(false)
    expect(testAdditionsRequested('不要新增测试，只运行现有测试')).toBe(false)
    expect(testAdditionsRequested('Do not modify tests. Add tests elsewhere.')).toBe(false)
  })

  it.each([
    ['确保 node --test test/feature.test.mjs 全部通过，并补充针对这些问题的回归断言。', true],
    ['新增缓存失效的测试断言。', true],
    ['Add regression assertions for the reported failures.', true],
    ['Extend test assertions for the cache behavior.', true],
    ['不要补充回归断言，只运行现有用例。', false],
    ['禁止修改测试断言，但新增其他测试。', false],
    ['Do not add regression assertions. Run existing tests.', false],
    ['Never modify test assertions. Add tests elsewhere.', false],
    ['补充原因说明，并运行现有回归断言。', false],
    ['Add runtime assertions to the application.', false],
    ['把方案写到 docs/plans/change.md，确认后再把代码和测试（test/audit.test.mjs）实现完整。', true],
    ['实现代码和测试。', true],
    ['Implement code and tests for the feature.', true],
    ['把代码实现完整，不要把测试实现或修改。', false],
    ['Do not implement tests. Implement the application only.', false],
    ['只分析现有测试是否实现完整，不要改代码。', false],
    ['实现代码和测试，但不要改现有测试。', false],
    ['实现代码和测试，但别动测试。', false],
    ['Implement tests, but do not touch tests.', false],
    ['分别实现代码和测试。', true],
  ])('recognizes explicit assertion additions without relaxing test protection: %s', (intent, expected) => {
    expect(testAdditionsRequested(intent)).toBe(expected)
  })

  it.each([false, true])('allows new candidate test correction while preserving old evidence (explicit additions=%s)', async explicitAdditions => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-new-test-fix-'))
    const store = join(root, 'data')
    try {
      await freezeCheckDefinitions(root, store, explicitAdditions)
      await writeFile(join(root, 'new.test.mjs'), "throw new Error('incorrect new fixture')\n")
      const first = await finishCheck(root, await captureCheck(root, root, 'node', ['--test', 'new.test.mjs']), store)
      await writeFile(join(root, 'new.test.mjs'), "import test from 'node:test'\ntest('corrected fixture', () => {})\n")
      const runtime = new PulseRuntime()
      runtime.state.results.set('result-1', { id: 'result-1', privacy: 'public', derivedFrom: [], value: { code: 0, checkReceipt: first as any } })
      expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual(['result-1'])
      const rerun = await finishCheck(root, await captureCheck(root, root, 'node', ['--test', 'new.test.mjs']), store)
      expect(rerun.definitionChanged).toBe(false)
      runtime.state.results.get('result-1')!.value = { code: 0, checkReceipt: rerun as any }
      expect(await staleFileEvidence(root, ['result-1'], runtime)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not reinterpret legacy frozen runs or explicit test restrictions as candidate authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-candidate-policy-'))
    const store = join(root, 'data')
    try {
      expect(candidateTestChangesAllowed('Refactor modules and run tests with zero regressions.')).toBe(true)
      expect(candidateTestChangesAllowed('Do not modify existing tests.')).toBe(true)
      expect(candidateTestChangesAllowed('不要修改原有测试。')).toBe(true)
      expect(candidateTestChangesAllowed('不要修改原有测试，新增独立测试。')).toBe(true)
      expect(candidateTestChangesAllowed('不要修改业务代码，只新增测试。')).toBe(true)
      expect(candidateTestChangesAllowed('Do not modify source code. Add tests.')).toBe(true)
      for (const intent of ['不要新增测试，只运行原有测试', '禁止修改任何测试', 'Do not add tests.', 'Never modify any tests.']) expect(candidateTestChangesAllowed(intent)).toBe(false)
      await freezeCheckDefinitions(root, store, false, false)
      await writeFile(join(root, 'new.test.mjs'), "import test from 'node:test'\ntest('candidate', () => {})\n")
      const current = await captureCheck(root, root, 'node', ['--test', 'new.test.mjs'])
      expect((await finishCheck(root, current, store)).definitionChanged).toBe(true)
      await rm(join(store, 'candidate-test-policy.json'))
      await writeFile(join(root, 'new.test.mjs'), "import test from 'node:test'\ntest('changed candidate', () => {})\n")
      expect((await finishCheck(root, await captureCheck(root, root, 'node', ['--test', 'new.test.mjs']), store)).definitionChanged).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not turn HTTP validation plus a test-runner flag into CLI option acceptance', () => {
    const criteria = [{ id: 'http', description: 'GET /api/items 接入查询参数，POST 非法 URL 返回 400 error。' }]
    expect(requiredArgumentChecks({ objective: '补齐 HTTP 功能与参数验证，并运行 node --test。', acceptanceCriteria: criteria })).toEqual([])
    expect(requiredArgumentChecks({ objective: '实现 CLI --calls 并修复 HTTP 服务。', acceptanceCriteria: [...criteria, { id: 'cli', description: '非法预算参数必须报错' }] }).map(c => c.id)).toEqual(['cli'])
    expect(requiredArgumentChecks({ objective: '检查 --budget 参数', acceptanceCriteria: [{ id: 'args', description: 'invalid budget must fail' }] }).map(c => c.id)).toEqual(['args'])
  })
})

it('explains rejected top-level additions while preserving the baseline and allowing callback-local setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-test-addition-diagnostic-'))
  const store = join(root, 'data'), path = 'test/example.test.mjs'
  const original = "import test from 'node:test'\ntest('baseline', () => {})\n"
  try {
    await mkdir(join(root, 'test')); await writeFile(join(root, path), original)
    await freezeCheckDefinitions(root, store, true)
    await expect(assertCheckEdit(root, store, path, original + "\nimport http from 'node:http'\n")).rejects.toMatchObject({ code: 'FROZEN_TEST_CHANGE', details: { path, additionsAllowed: true, constraints: expect.stringContaining('inside the appended test callback') } })
    expect(await readFile(join(root, path), 'utf8')).toBe(original)
    await expect(assertCheckEdit(root, store, path, original + "\ntest('extra', async () => { const http = await import('node:http'); const helper = () => Boolean(http); if (!helper()) throw Error('missing'); })\n")).resolves.toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { probeResumeIntegration, resumeCheckIds } from './long-task-resume-probe.mjs'
import { evaluationResumeAcceptance } from './long-task-acceptance.mjs'

test('resume acceptance binds nine independent assertions and honors cancellation', async () => {
  const adapter = evaluationResumeAcceptance('/unused', '/unused', '为 runner 增加 --resume 并保留记录。')
  assert.deepEqual(adapter.checks[0].expectedChecks, resumeCheckIds)
  assert.equal(adapter.checks[0].toolName, 'evaluation-acceptance.resume')
  const { CapabilityPackRegistry } = await import('../../packages/server/dist/capabilities.js')
  const registry = new CapabilityPackRegistry()
  registry.register(adapter.pack)
  const active = await registry.activate([adapter.pack.manifest.id], { workspaceRoot: '/unused', config: {}, signal: new AbortController().signal })
  await active.dispose()
  await assert.rejects(probeResumeIntegration('/unused', '/unused', { signal: AbortSignal.abort() }), /abort/i)
})

test('actual offline runner passes nine resume checks and failed-terminal mutation is caught', async () => {
  const root = resolve(new URL('../..', import.meta.url).pathname), dir = await mkdtemp(join(tmpdir(), 'pulse-resume-probe-'))
  try {
    const checks = await probeResumeIntegration(root, join(dir, 'positive'))
    assert.equal(checks.length, 9)
    assert.ok(checks.every(c => c.passed), JSON.stringify(checks))
    const source = join(dir, 'mutant'); await cp(join(dir, 'positive/workspace'), source, { recursive: true, filter: p => !['node_modules', 'packages'].includes(p.split('/').at(-1)) })
    const helper = join(source, 'scripts/eval/resume.mjs'), text = await readFile(helper, 'utf8')
    assert.ok(text.includes("'failed'"))
    await writeFile(helper, text.replace("'failed',", ''))
    const negative = await probeResumeIntegration(source, join(dir, 'negative'))
    assert.equal(negative.find(c => c.id === 'all-six-terminal-statuses').passed, false)
    assert.equal(negative.find(c => c.id === 'actual-runner-failure-resume-no-replay').passed, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

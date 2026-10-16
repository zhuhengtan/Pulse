import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gradeCase } from './long-task-grade.mjs'
import { save, manifest } from './long-task-lib.mjs'

test('grader rejects unchanged baseline files and syntax errors posing as expected conflict failure', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pulse-grader-regression-'))
  try {
    const workspace = join(output, 'LT03/workspace')
    await mkdir(join(workspace, 'scripts/eval'), { recursive: true })
    await mkdir(join(workspace, 'fixtures'), { recursive: true })
    await writeFile(join(workspace, 'fixtures/run-records.json'), JSON.stringify([{ runId: 'r1', status: 'succeeded', usage: { modelCalls: 2, inputTokens: 3, outputTokens: 4 } }]))
    await writeFile(join(workspace, 'README.md'), 'unchanged baseline')
    save(join(output, 'LT03/before.json'), await manifest(workspace))
    await writeFile(join(workspace, 'scripts/eval/audit-runs.mjs'), 'export function unfinished( {')
    save(join(output, 'LT03/result.json'), { outcome: { status: 'failed' }, outerAttempts: 1 })
    save(join(output, 'frozen.json'), { dataset: { limits: { perSampleCalls: 64 } } })
    const grade = await gradeCase(output, { id: 'LT03', deliverables: ['README.md', 'scripts/eval/audit-runs.mjs'] })
    assert.equal(grade.checks.find(check => check.name === '产物: README.md').passed, false)
    assert.equal(grade.checks.find(check => check.name === '拒绝冲突记录').passed, false)
    assert.equal(grade.checks.find(check => check.name === '执行数据核算脚本').passed, false)
  } finally { await rm(output, { recursive: true, force: true }) }
})

test('documentation grader rejects old attempt promises, ledger deletion advice and resume conflation despite keywords', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pulse-doc-grader-'))
  try {
    const workspace = join(output, 'LT05/workspace')
    await mkdir(join(workspace, 'packages/server/src/task-controller'), { recursive: true })
    await mkdir(join(workspace, 'docs/reviews'), { recursive: true })
    await writeFile(join(workspace, 'packages/server/src/task-controller/program.ts'), "const programVersion = options.version ?? '11'")
    await writeFile(join(workspace, 'packages/server/src/task-controller/state.ts'), 'export const maxStageAttempts = 4')
    for (const path of ['docs/task-controller.md', 'docs/cli-config.md', 'docs/cli-config.en.md', 'docs/reviews/documentation-maintenance.md']) await writeFile(join(workspace, path), 'old')
    save(join(output, 'LT05/before.json'), await manifest(workspace))
    const paths = ['docs/task-controller.md', 'docs/cli-config.md', 'docs/cli-config.en.md', 'docs/reviews/documentation-maintenance.md']
    await writeFile(join(workspace, paths[0]), 'version 11; maxStageAttempts = 4\nAn achievable correction gets at most one additional attempt.')
    await writeFile(join(workspace, paths[1]), 'maxModelCalls maxTurns ENOTFOUND resume\n只有显式发送包含“继续/resume”的指令才会触发恢复。')
    await writeFile(join(workspace, paths[2]), 'maxModelCalls maxTurns ENOTFOUND resume')
    await writeFile(join(workspace, paths[3]), '提高预算或清理预算文件。')
    save(join(output, 'LT05/result.json'), { outcome: { status: 'succeeded' }, outerAttempts: 1 })
    save(join(output, 'LT05/attempts.jsonl'), {})
    // Empty request history is sufficient: these checks do not need any provider.
    await writeFile(join(output, 'LT05/attempts.jsonl'), '')
    save(join(output, 'frozen.json'), { dataset: { limits: { perSampleCalls: 64 } } })
    const bad = await gradeCase(output, { id: 'LT05', deliverables: paths })
    for (const name of ['移除过时尝试承诺', '不建议删除或清空预算', '区分会话恢复与文本续做']) assert.equal(bad.checks.find(c => c.name === name).passed, false, name)
    await writeFile(join(workspace, paths[0]), 'version 11; maxStageAttempts = 4 total attempts')
    await writeFile(join(workspace, paths[1]), 'maxModelCalls maxTurns ENOTFOUND resume\n恢复原运行与发送继续是不同操作。')
    await writeFile(join(workspace, paths[3]), 'Never delete budget ledger. 不要清理预算文件。')
    const good = await gradeCase(output, { id: 'LT05', deliverables: paths })
    assert.equal(good.checks.every(c => c.passed), true, JSON.stringify(good.checks))
  } finally { await rm(output, { recursive: true, force: true }) }
})

test('report generator writes real Markdown lines without inventing a permission blocker', async () => {
  const { execFileSync } = await import('node:child_process')
  const output = await mkdtemp(join(tmpdir(), 'pulse-report-format-'))
  try {
    save(join(output, 'frozen.json'), { dataset: { tasks: [] }, sourceManifest: {}, sourceRevision: 'offline fixture' })
    save(join(output, 'budget.json'), { samples: {}, used: 0, totalLimit: 96, sampleLimit: 16 })
    const docs = join(output, 'reports')
    execFileSync(process.execPath, [new URL('./long-task-report.mjs', import.meta.url).pathname, output, docs])
    const report = await (await import('node:fs/promises')).readFile(join(docs, 'README.md'), 'utf8')
    assert.ok(report.split('\n').length > 20)
    assert.equal(report.includes('\\n\\n'), false)
    assert.match(report, /尚未执行真实样本/)
    assert.doesNotMatch(report, /自动审批阻断|需要明确授权/)
  } finally { await rm(output, { recursive: true, force: true }) }
})

test('null evaluator budget is not applicable and does not subtract points', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pulse-grade-no-cap-'))
  try {
    const dir = join(output, 'LT00'), workspace = join(dir, 'workspace')
    await mkdir(workspace, { recursive: true })
    save(join(dir, 'before.json'), await manifest(workspace))
    save(join(dir, 'result.json'), { outcome: { status: 'succeeded' }, outerAttempts: 42 })
    save(join(output, 'frozen.json'), { dataset: { limits: { perSampleCalls: null } } })
    const unlimited = await gradeCase(output, { id: 'LT00', deliverables: [] })
    assert.equal(unlimited.budgetStatus, 'not_applicable')
    save(join(output, 'frozen.json'), { dataset: { limits: { perSampleCalls: 64 } } })
    const bounded = await gradeCase(output, { id: 'LT00', deliverables: [] })
    assert.equal(unlimited.provisionalScore, bounded.provisionalScore)
  } finally { await rm(output, { recursive: true, force: true }) }
})

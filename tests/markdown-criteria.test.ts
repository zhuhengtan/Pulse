import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective, continueTaskRecord, taskRecordFromGlobal } from '../packages/server/src/task.js'

it('does not invent requirements from Markdown hard-break clauses in new tasks', () => {
  const text = '请按顺序执行：\\\n阶段 1：迁移 users；\\\n阶段 2：迁移 permissions；\\\n阶段 3：验证并写总结。'
  const old = acceptanceCriteriaFromObjective(text), next = acceptanceCriteriaFromObjective(text, undefined, 2)
  expect(old.filter(c => c.description === '\\')).toHaveLength(2)
  expect(next.map(c => c.description)).toEqual(old.filter(c => c.description !== '\\').map(c => c.description))
  for (const c of next) {
    expect(text.slice(c.source!.start, c.source!.end)).toBe(c.description)
    expect(c.source!.hash).toBe(createHash('sha256').update(text).digest('hex'))
  }
})

it.each([
  '写入 C:\\temp\\\n再验证目录。',
  '输出双反斜杠；\\\\\n再验证。',
  '```text\n原始行；\\\n```\n保留内容。',
  '使用 `literal; \\\nnext` 验证输出。',
  '\\\n保留这一字面行。',
  '输出原文；\\',
])('preserves literal paths, escaped slashes, code and non-continuations: %s', text => {
  expect(acceptanceCriteriaFromObjective(text, undefined, 2)).toEqual(acceptanceCriteriaFromObjective(text))
})

it('preserves the parser version and frozen criteria through task continuation', () => {
  const text = '迁移；\\\n验证。'
  for (const version of [undefined, 2] as const) {
    const record = { schemaVersion: 1, runId: 'old', objective: text, ...(version ? { criteriaParsingVersion: version } : {}), acceptanceCriteria: acceptanceCriteriaFromObjective(text, undefined, version), status: 'in_progress', replanCount: 0, attempts: [], evidenceRefs: [], excludedRefs: [] }
    const restored = taskRecordFromGlobal({ taskRecord: record as any })!
    const continued = continueTaskRecord(restored, 'next')
    expect(continued.criteriaParsingVersion).toBe(version)
    expect(continued.acceptanceCriteria).toEqual(record.acceptanceCriteria)
    expect(continued.objective).toBe(text)
  }
})

it('persists new parsing semantics through the actual Host and a cold continuation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-markdown-criteria-'))
  const options = { cwd, dataDir: join(cwd, 'data'), jarvis: { enabled: false }, maxModelCalls: 16, mockResponse: 'Need more work.' }
  const objective = '迁移 users；\\\n迁移 permissions；\\\n验证并写总结。'
  let host = createLocalHost(options)
  try {
    const c = await host.createConversation(), first = await host.sendMessage(c.id, { text: objective })
    await first.outcome()
    const directory = join(cwd, 'data/conversations', c.id, 'runs')
    const initial = JSON.parse(await readFile(join(directory, first.id, 'task-record.json'), 'utf8'))
    expect(initial.criteriaParsingVersion).toBe(2)
    expect(initial.objective).toBe(objective)
    expect(initial.acceptanceCriteria).toHaveLength(3)
    expect(JSON.parse(await readFile(join(directory, first.id, 'input.json'), 'utf8')).criteriaParsingVersion).toBe(2)
    await host.close(); host = createLocalHost(options)
    const next = await host.sendMessage(c.id, { text: '继续', continueTask: true }); await next.outcome()
    const continued = JSON.parse(await readFile(join(directory, next.id, 'task-record.json'), 'utf8'))
    expect(continued.criteriaParsingVersion).toBe(2)
    expect(continued.acceptanceCriteria).toEqual(initial.acceptanceCriteria)
    expect(continued.objective).toBe(objective)
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }) }
})

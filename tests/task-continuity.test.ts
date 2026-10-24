import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { continueTaskRecord, isInterruptedTaskContinuation, isTaskContinuation, taskRecordFromGlobal } from '../packages/server/src/task.js'

describe('durable task continuity', () => {
  it.each(['explicit', 'interrupted'] as const)('keeps one call allowance across new-controller continuation and cold host restart: %s', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-continuity-budget-'))
    const options = { cwd: directory, dataDir: join(directory, 'data'), taskController: true, maxModelCalls: 4, mockResponse: 'Need more work.' }
    let host = createLocalHost(options)
    try {
      const conversation = await host.createConversation()
      const first = await host.sendMessage(conversation.id, { text: 'Create and verify a report.' }); await first.outcome()
      const firstCalls = (await first.usage()).modelCalls
      await host.close(); host = createLocalHost(options)
      const next = await host.sendMessage(conversation.id, mode === 'explicit' ? { text: '继续', continueTask: true } : { text: '刚才运行在中途被中断了。请先检查工作区里哪些阶段产物已经生成，切勿破坏已完成的文件，继续把剩余未完成的任务全部完成。' }); await next.outcome()
      const nextCalls = (await next.usage()).modelCalls
      expect(firstCalls + nextCalls).toBeLessThanOrEqual(4)
      const budget = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', next.id, 'model-budget.json'), 'utf8'))
      expect(budget.limit).toBe(4 - firstCalls)
      expect(budget.inheritedFrom).toContain(first.id)
      const record = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', next.id, 'task-record.json'), 'utf8'))
      expect(record.objective).toBe('Create and verify a report.')
      expect(record.acceptanceCriteria[0].description).toBe('Create and verify a report.')
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it('preserves original criteria across host restart and refuses subset-only acceptance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-continuity-'))
    const options = { cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'Only A is done.', mockTaskAssessments: [{ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-1'], rationale: 'A is done' }] }] }
    let host = createLocalHost(options)
    try {
      const conversation = await host.createConversation()
      const initial = await host.sendMessage(conversation.id, { text: '1. Deliver A\n2. Deliver B' })
      await initial.outcome()
      await host.close()
      host = createLocalHost(options)
      const next = await host.sendMessage(conversation.id, { text: '继续，这轮只完成 A' })
      await next.outcome()
      expect((await next.taskOutcome())?.status).not.toBe('accepted')
      const record = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', next.id, 'task-record.json'), 'utf8'))
      expect(record.objective).toBe('1. Deliver A\n2. Deliver B')
      expect(record.acceptanceCriteria).toHaveLength(2)
      expect(record.continuedFromRunId).toBe(initial.id)
      expect(record.assessments[1].status).toBe('unverifiable')
      const unrelated = await host.sendMessage(conversation.id, { text: 'Explain C' })
      await unrelated.outcome()
      const fresh = JSON.parse(await readFile(join(directory, 'data', 'conversations', conversation.id, 'runs', unrelated.id, 'task-record.json'), 'utf8'))
      expect(fresh.objective).toBe('Explain C')
      expect(fresh.continuedFromRunId).toBeUndefined()
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('reads legacy records and does not reuse cross-run ResultRefs', () => {
    const old = taskRecordFromGlobal({ taskRecord: { schemaVersion: 1, runId: 'old', objective: 'A', acceptanceCriteria: [{ id: 'criterion-1', description: 'A' }], status: 'incomplete', replanCount: 2, attempts: [], evidenceRefs: ['result-1'], excludedRefs: [] } })!
    const next = continueTaskRecord(old, 'new')
    expect(next.evidenceRefs).toEqual([])
    expect(next.attempts).toEqual([])
    expect(next.replanCount).toBe(0)
    expect(next.objective).toBe('A')
    expect(isTaskContinuation('继续之前的优化')).toBe(true)
    expect(isTaskContinuation('为什么没有继续？')).toBe(false)
    expect(isInterruptedTaskContinuation('新任务：上次程序中断，新增继续任务功能')).toBe(false)
    expect(isInterruptedTaskContinuation('刚才任务中断了，不要继续剩余工作')).toBe(false)
    expect(isInterruptedTaskContinuation('The previous task was interrupted. Resume the remaining work.')).toBe(true)
  })

  it('continues correctable items even when a different criterion is blocked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-partial-block-'))
    const host = createLocalHost({ cwd: directory, dataDir: join(directory, 'data'), mockResponse: 'A blocked; B missing', mockReplanResponses: ['A blocked; B done'], mockTaskAssessments: [
      { status: 'unverifiable', criteria: [{ criterionId: 'criterion-1', status: 'unverifiable', evidenceRefs: [], rationale: 'Needs user choice' }, { criterionId: 'criterion-2', status: 'not_met', evidenceRefs: ['result-1'], rationale: 'Complete independent B' }] },
      { status: 'unverifiable', criteria: [{ criterionId: 'criterion-1', status: 'unverifiable', evidenceRefs: [], rationale: 'Needs user choice' }, { criterionId: 'criterion-2', status: 'passed', evidenceRefs: ['result-3'], rationale: 'B done' }] },
    ] })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: '1. A\n2. B' })
      await run.outcome()
      expect(await run.taskOutcome()).toMatchObject({ status: 'unverifiable', replanCount: 1, criteria: [{ status: 'unverifiable' }, { status: 'passed' }] })
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }) }
  })
})

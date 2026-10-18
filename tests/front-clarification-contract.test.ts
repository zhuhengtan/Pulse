import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { createBuiltinSkillCapabilityPack } from '../packages/server/src/builtin-skills.js'

async function fixture(questions = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-clarification-contract-'))
  let calls = 0
  const server = createServer((_req, response) => {
    const clarify = calls++ < questions
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ response: JSON.stringify({ instantResponse: '收到', brief: { intent: '修复登录重复提交', requirements: ['前置模型额外猜测，不能成为原始验收条目'], needsClarification: clarify, ...(clarify ? { clarificationQuestion: `请补充第 ${calls} 个信息？` } : {}) } }) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const options = { cwd: directory, dataDir: join(directory, 'data'), mockResponse: '已读取请求', taskController: false, frontModel: { enabled: true, model: 'fixture', baseURL: `http://127.0.0.1:${port}` } }
  return { directory, options, async close() { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) } }
}

it.each([false, true])('keeps source-backed requirements and attachment criteria after a clarification (host restart=%s)', async cold => {
  const f = await fixture(), original = '修复登录按钮重复提交。\n增加回归测试。'
  await writeFile(join(f.directory, 'requirements.txt'), '禁止新增依赖。')
  let host = createLocalHost(f.options)
  try {
    const conversation = await host.createConversation()
    const first = await host.sendMessage(conversation.id, { text: original, requirementPaths: ['requirements.txt'] }); await first.outcome()
    const firstRecord = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', first.id, 'task-record.json'), 'utf8'))
    if (cold) { await host.close(); host = createLocalHost(f.options) }
    const second = await host.sendMessage(conversation.id, { text: 'src/login.ts' }); await second.outcome()
    const record = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', second.id, 'task-record.json'), 'utf8'))
    expect(record.objective).toContain(original)
    expect(record.objective).toContain('src/login.ts')
    expect(record.continuedFromRunId).toBe(first.id)
    expect(record.acceptanceCriteria.slice(0, 3)).toEqual(firstRecord.acceptanceCriteria)
    expect(record.acceptanceCriteria.map((c: any) => c.description)).toEqual(['修复登录按钮重复提交。', '增加回归测试。', '禁止新增依赖。', 'src/login.ts'])
    expect(record.acceptanceCriteria[0].source.hash).toBe(createHash('sha256').update(original).digest('hex'))
    expect(record.acceptanceCriteria[2].source.document).toBe('requirements.txt')
    expect(record.acceptanceCriteria[3].source.hash).toBe(createHash('sha256').update('src/login.ts').digest('hex'))
    expect(JSON.stringify(record)).not.toContain('前置模型额外猜测')
  } finally { await host.close(); await f.close() }
})

it('retains the original contract through multiple questions and an intervening status turn', async () => {
  const f = await fixture(2), host = createLocalHost(f.options)
  try {
    const conversation = await host.createConversation()
    const first = await host.sendMessage(conversation.id, { text: '修复登录按钮重复提交。' }); await first.outcome()
    const second = await host.sendMessage(conversation.id, { text: 'src/login.ts' }); await second.outcome()
    const status = await host.sendMessage(conversation.id, { text: '进度如何？' }); await status.outcome()
    const third = await host.sendMessage(conversation.id, { text: '使用现有测试验证' }); await third.outcome()
    const record = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', third.id, 'task-record.json'), 'utf8'))
    expect(record.continuedFromRunId).toBe(second.id)
    expect(record.acceptanceCriteria.map((c: any) => c.description)).toEqual(['修复登录按钮重复提交。', 'src/login.ts', '使用现有测试验证'])
    expect(record.objective).not.toBe('根据上一轮真实执行记录回答当前追问，不重复修改文件')
  } finally { await host.close(); await f.close() }
})

it.each([{ text: '新任务：只解释缓存原理' }, { text: '只解释缓存原理', continueTask: false }])('does not inherit a pending clarification when the caller starts another task: %j', async input => {
  const f = await fixture(), host = createLocalHost(f.options)
  try {
    const conversation = await host.createConversation()
    const first = await host.sendMessage(conversation.id, { text: '修复登录重复提交。' }); await first.outcome()
    const second = await host.sendMessage(conversation.id, input); await second.outcome()
    const record = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', second.id, 'task-record.json'), 'utf8'))
    expect(record.objective).toBe(input.text)
    expect(record.continuedFromRunId).toBeUndefined()
  } finally { await host.close(); await f.close() }
})

const frozenCheck = { id: 'caller-check', description: 'Caller-owned check', criterionIds: ['criterion-1'], toolName: 'fs.read', input: { path: 'validation.mjs' }, expectedChecks: ['reject-invalid'], covers: [] }

it('retains caller-owned frozen checks through a clarification and a restart with empty configured checks', async () => {
  const f = await fixture()
  let host = createLocalHost({ ...f.options, taskController: true, maxModelCalls: 8, acceptanceChecks: [frozenCheck] })
  try {
    const conversation = await host.createConversation()
    const first = await host.sendMessage(conversation.id, { text: '修复登录重复提交' }); await first.outcome()
    const original = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', first.id, 'task-record.json'), 'utf8'))
    expect(original.acceptanceChecks).toEqual([frozenCheck])
    await host.close()
    host = createLocalHost({ ...f.options, taskController: true, maxModelCalls: 8, acceptanceChecks: [] })
    const next = await host.sendMessage(conversation.id, { text: 'src/login.ts' }); await next.outcome()
    const record = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', next.id, 'task-record.json'), 'utf8'))
    expect(record.acceptanceChecks).toEqual([frozenCheck])
    expect((await next.taskOutcome())?.status).not.toBe('accepted')
  } finally { await host.close(); await f.close() }
})

it.each(['changed', 'disabled'] as const)('rejects an attempt to replace pending frozen acceptance: %s', async change => {
  const f = await fixture()
  let host = createLocalHost({ ...f.options, taskController: true, acceptanceChecks: [frozenCheck] })
  try {
    const conversation = await host.createConversation()
    const first = await host.sendMessage(conversation.id, { text: '修复登录重复提交' }); await first.outcome()
    await host.close()
    host = createLocalHost({ ...f.options, taskController: change !== 'disabled', acceptanceChecks: change === 'changed' ? [{ ...frozenCheck, expectedChecks: ['weaker-check'] }] : [] })
    await expect(host.sendMessage(conversation.id, { text: 'src/login.ts' })).rejects.toThrow(change === 'changed' ? 'ACCEPTANCE_CONTRACT_CHANGED_DURING_CLARIFICATION' : 'ACCEPTANCE_CONTROLLER_REQUIRED')
    const original = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', first.id, 'task-record.json'), 'utf8'))
    expect(original.acceptanceChecks).toEqual([frozenCheck])
  } finally { await host.close(); await f.close() }
})

it('preserves skill selection and pre-implementation routing after a filename clarification', async () => {
  const f = await fixture(), host = createLocalHost({ ...f.options, taskController: true, capabilityPacks: [createBuiltinSkillCapabilityPack()], enabledCapabilityPacks: ['builtin-skills'] })
  const original = '/grill-and-plan 先生成计划，确认后再实现登录修复'
  try {
    const conversation = await host.createConversation()
    const first = await host.sendMessage(conversation.id, { text: original }); await first.outcome()
    const next = await host.sendMessage(conversation.id, { text: 'src/login.ts' }); await next.outcome()
    const input = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', next.id, 'input.json'), 'utf8'))
    expect(input.taskController).toBe(false)
    expect(input.goal).toContain(original)
    expect(input.goal).toContain('src/login.ts')
    const record = JSON.parse(await readFile(join(f.options.dataDir, 'conversations', conversation.id, 'runs', next.id, 'task-record.json'), 'utf8'))
    expect(record.acceptanceCriteria.map((item: any) => item.description)).toEqual([original, 'src/login.ts'])
  } finally { await host.close(); await f.close() }
})

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost } from '../packages/server/src/index.js'
import { prepareWorkspaceDependencies } from '../packages/server/src/h5/dependencies.js'
import { isTaskContinuation } from '../packages/server/src/task.js'
import { PulseRuntime, type LaneProgram } from '@hunterzhu/pulse-runtime'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'pulse-chat-recovery-')); roots.push(root); return root }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const assistantOptions = { provider: { provider: 'mock' as const, defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock' as const, defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock' }

it.each([true, false])('executes assistant work.start only after an approved human decision (%s)', async approved => {
  const root = await directory()
  const start = vi.fn(async () => ({ conversationId: 'work-1', projectId: 'p', title: 'Inspect' }))
  const host = createLocalHost({ ...assistantOptions, cwd: root, dataDir: join(root, 'data'), approvalMode: 'ask', mockToolCalls: [{ name: 'work.start', input: { projectId: 'p', task: 'Inspect' } }], mockAfterToolResponse: 'Started' })
  host.setAssistantWorkTools({ start, list: async () => [], status: async () => ({}), send: async () => {}, stop: async () => {}, resume: async () => {} })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: '请调用 work.start 查看项目', assistantChat: true })
    let approvals = 0
    for await (const event of run.events) if (event.type === 'waiting') {
      expect(start).not.toHaveBeenCalled()
      const pending = await run.pendingInteractions(); expect(pending[0]?.kind).toBe('approval')
      await run.reply(pending[0]!.items[0]!.effectId, { approved }); approvals++
    }
    expect(approvals).toBe(1); expect(start).toHaveBeenCalledTimes(approved ? 1 : 0)
    expect(await run.outcome()).toMatchObject({ status: approved ? 'succeeded' : 'failed' })
  } finally { await host.close() }
})

it('executes assistant read tools without an approval prompt', async () => {
  const root = await directory(); await writeFile(join(root, 'notes.txt'), 'reference')
  const host = createLocalHost({ ...assistantOptions, cwd: root, dataDir: join(root, 'data'), approvalMode: 'ask', mockToolCalls: [{ name: 'fs.read', input: { path: 'notes.txt' } }], mockAfterToolResponse: 'Read' })
  try {
    const conversation = await host.createConversation(); const run = await host.sendMessage(conversation.id, { text: '读取 notes.txt', assistantChat: true })
    for await (const event of run.events) expect(event.type).not.toBe('waiting')
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
  } finally { await host.close() }
})

it('hands a local reviewer DENY to the user and resumes the approved assistant operation once', async () => {
  const root = await directory(); let modelCalls = 0, reviews = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const body = JSON.parse(String(options.body))
    const safety = body.messages.some((message: { content: string }) => message.content.includes('You are the Pulse safety reviewer'))
    if (safety) reviews++
    const tool = !safety && modelCalls++ === 0
    const message = tool ? { content: '', tool_calls: [{ id: 'start', function: { name: 'work_start', arguments: JSON.stringify({ projectId: 'p', task: 'Inspect' }) } }] } : { content: safety ? 'DENY' : 'Started' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  }))
  const profile = { provider: 'openai-compatible' as const, defaultModel: 'fixture', baseURL: 'http://127.0.0.1:12345/v1' }
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: profile, providerProfiles: { fixture: profile }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', approvalMode: 'auto', approvalReview: { provider: 'ollama', model: 'review-fixture', baseURL: 'http://127.0.0.1:11434', timeoutMs: 30000 } })
  const start = vi.fn(async () => ({ conversationId: 'work-1', projectId: 'p', title: 'Inspect' }))
  host.setAssistantWorkTools({ start, list: async () => [], status: async () => ({}), send: async () => {}, stop: async () => {}, resume: async () => {} })
  try {
    const conversation = await host.createConversation(); const run = await host.sendMessage(conversation.id, { text: '请调用 work.start 查看项目', assistantChat: true })
    let approvals = 0
    for await (const event of run.events) if (event.type === 'waiting') {
      expect(start).not.toHaveBeenCalled()
      const pending = await run.pendingInteractions(); await run.reply(pending[0]!.items[0]!.effectId, { approved: true }); approvals++
    }
    const outcome = await run.outcome(); expect(outcome).toMatchObject({ status: 'succeeded' }); expect(reviews).toBe(1); expect(approvals).toBe(1); expect(start).toHaveBeenCalledTimes(1)
  } finally { await host.close() }
})

it('keeps original task criteria when the follow-up reports a missing plan', async () => {
  const root = await directory(); const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), mockResponse: 'Pending' })
  try {
    const conversation = await host.createConversation()
    const first = await host.sendMessage(conversation.id, { text: '1. 修复审批\n2. 验证完整链路' }); await first.outcome()
    const next = await host.sendMessage(conversation.id, { text: '没有计划文件啊' }); await next.outcome()
    const record = JSON.parse(await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', next.id, 'task-record.json'), 'utf8'))
    expect(record.objective).toBe('1. 修复审批\n2. 验证完整链路'); expect(record.continuedFromRunId).toBe(first.id)
    const path = join(root, 'data', 'conversations', conversation.id, 'runs', next.id, 'task-record.json')
    await writeFile(path, JSON.stringify({ ...record, objective: '没有计划文件啊', continuedFromRunId: undefined }))
    const recovered = await host.sendMessage(conversation.id, { text: '继续' }); await recovered.outcome()
    const restored = JSON.parse(await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', recovered.id, 'task-record.json'), 'utf8'))
    expect(restored.objective).toBe('1. 修复审批\n2. 验证完整链路')
    expect(isTaskContinuation('新任务：写一份没有计划文件的说明')).toBe(false)
    expect(isTaskContinuation('解释一下新的数据库方案')).toBe(false)
  } finally { await host.close() }
})

it('copies local dependencies with relocated links and independent writes, including existing workspaces', async () => {
  const root = await directory(), source = join(root, 'source'), target = join(root, 'target')
  await mkdir(join(source, 'node_modules', 'pkg'), { recursive: true }); await mkdir(target)
  await writeFile(join(source, 'node_modules', 'pkg', 'index.js'), 'original')
  await writeFile(join(source, 'package.json'), JSON.stringify({ main: './dist/index.js' }))
  await mkdir(join(source, 'dist')); await writeFile(join(source, 'dist', 'index.js'), 'compiled')
  await symlink('pkg', join(source, 'node_modules', 'alias'), process.platform === 'win32' ? 'junction' : undefined)
  await symlink(join(source, 'node_modules', 'pkg'), join(source, 'node_modules', 'absolute-alias'), process.platform === 'win32' ? 'junction' : undefined)
  await prepareWorkspaceDependencies(source, target, ['package.json'])
  expect(await readFile(join(target, 'dist', 'index.js'), 'utf8')).toBe('compiled')
  expect(await readFile(join(target, 'node_modules', 'alias', 'index.js'), 'utf8')).toBe('original')
  expect(await readFile(join(target, 'node_modules', 'absolute-alias', 'index.js'), 'utf8')).toBe('original')
  await writeFile(join(target, 'node_modules', 'pkg', 'index.js'), 'task edit')
  expect(await readFile(join(source, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('original')
  await prepareWorkspaceDependencies(source, target, [])
  expect(await readFile(join(target, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('task edit')
})

it('retains ATTEMPT_TIMEOUT when an aborted executor reports a generic cancellation', async () => {
  let started = false
  const runtime = new PulseRuntime({ effectExecutor: async (_effect, signal) => new Promise(resolve => { started = true; signal.addEventListener('abort', () => resolve({ value: null, status: 'cancelled', sideEffectState: 'none' }), { once: true }) }) })
  const program: LaneProgram = { id: 'timeout-reason', version: '1', step: ({ lane }) => lane.resume.step === 'start'
    ? { actions: [{ type: 'submit_effects', effects: [{ key: 'slow', kind: 'tool', concurrencyClass: 'tool', input: {}, sideEffectPolicy: 'external', attemptTimeoutMs: 5 }], wait: { onUnsatisfied: 'resume_with_error' } }], next: { programId: 'timeout-reason', programVersion: '1', step: 'done', locals: {} } }
    : { actions: [{ type: 'complete', result: null }], next: { programId: 'timeout-reason', programVersion: '1', step: 'done', locals: {} } } }
  const { agentId } = runtime.createAgent('timeout', program); runtime.tick()
  await vi.waitFor(() => expect(started).toBe(true))
  runtime.clock.advance(5); runtime.tick()
  await runtime.start(agentId).outcome()
  await vi.waitFor(() => expect(runtime.state.effects.get('effect-1')?.outcome).toMatchObject({ status: 'failed', error: { code: 'ATTEMPT_TIMEOUT' } }))
  await runtime.shutdown()
})

it('makes unmerged artifacts readable from their actual workspace and rejects changed or unrecorded files', async () => {
  const root = await directory(), work = join(root, 'work'); await mkdir(work)
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), approvalMode: 'auto', mockToolCalls: [{ name: 'fs.write', input: { path: 'plan.txt', content: 'plan' } }], mockAfterToolResponse: 'Created' })
  try {
    const conversation = await host.createConversation(); await host.setConversationExecutionWorkspace(conversation.id, work, root)
    const run = await host.sendMessage(conversation.id, { text: '创建 plan.txt' }); await run.outcome()
    expect(await host.listArtifacts(conversation.id)).toContainEqual(expect.objectContaining({ path: 'plan.txt', absolutePath: join(work, 'plan.txt'), workspaceState: 'isolated' }))
    expect(await host.readArtifact(conversation.id, 'plan.txt', run.id)).toMatchObject({ content: 'plan', workspaceState: 'isolated' })
    await expect(host.readArtifact(conversation.id, '../config.json', run.id)).rejects.toThrow('ARTIFACT_NOT_FOUND')
    await writeFile(join(work, 'plan.txt'), 'changed')
    await expect(host.readArtifact(conversation.id, 'plan.txt', run.id)).rejects.toThrow('ARTIFACT_CHANGED')
  } finally { await host.close() }
})

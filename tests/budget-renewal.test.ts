import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelAttemptBudget } from '../packages/server/src/model-budget.js'
import { createLocalHost, H5Server, startH5WorkWorker } from '../packages/server/src/index.js'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function root() { const p = await mkdtemp(join(tmpdir(), 'pulse-renewal-')); roots.push(p); return p }
const grant = { sourceRunId: 'parent', expectedUsed: 2, expectedLimit: 2, confirmed: true as const }
it('grants exactly 256 calls once, keeps the old ledger intact and preserves cost/token limits on restart', async () => {
  const dir = await root(), parentPath = join(dir, 'parent.json'), childPath = join(dir, 'child.json')
  const parent = await ModelAttemptBudget.open(parentPath, 2, 0, { maxTokens: 50, maxCostByCurrency: { USD: 5 } })
  for (let i = 0; i < 2; i++) { await parent.reserve(); await parent.recordUsage({ inputTokens: 10, outputTokens: 0, costs: [{ currency: 'USD', amount: 1 }] }, `parent-${i}`) }
  const before = await readFile(parentPath, 'utf8'), child = await ModelAttemptBudget.open(childPath, 4)
  await child.inheritRemaining(parentPath, grant)
  expect(child.limit).toBe(256); expect(child.used).toBe(0)
  await child.reserve(); await child.recordUsage({ inputTokens: 30, outputTokens: 0, costs: [{ currency: 'USD', amount: 1 }] }, 'child-1')
  await expect(child.reserve()).rejects.toMatchObject({ code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
  const restored = await ModelAttemptBudget.open(childPath, 256)
  await restored.inheritRemaining(parentPath, grant)
  expect(restored.used).toBe(1); expect(restored.limit).toBe(256)
  await expect(restored.reserve()).rejects.toMatchObject({ code: 'TASK_MODEL_CALL_BUDGET_EXHAUSTED' })
  expect(await readFile(parentPath, 'utf8')).toBe(before)
  await expect(restored.inheritRemaining(parentPath, { ...grant, expectedUsed: 1 })).rejects.toMatchObject({ code: 'TASK_MODEL_CALL_BUDGET_CORRUPT' })
})
it('does not renew an unspent allowance or a token/price limit', async () => {
  const dir = await root(), p = join(dir, 'p.json'), c = await ModelAttemptBudget.open(join(dir, 'c.json'), 256)
  const parent = await ModelAttemptBudget.open(p, 2, 0, { maxTokens: 10 })
  await expect(c.inheritRemaining(p, { ...grant, expectedUsed: 0 })).rejects.toMatchObject({ code: 'BUDGET_RENEWAL_STALE' })
  await parent.reserve(); await parent.recordUsage({ inputTokens: 10, outputTokens: 0 })
  expect(parent.canRenewCalls).toBe(false)
})
async function exhaustedHost() {
  const dir = await root(); let calls = 0
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, init)
    calls++
    return new Response(JSON.stringify({ choices: [{ message: calls <= 4 ? { content: null, tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: 'fs_list', arguments: '{"path":"."}' } }] } : { content: 'Finished after explicit continuation.' }, finish_reason: calls <= 4 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } })
  }))
  const host = createLocalHost({ cwd: dir, dataDir: join(dir, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture' }, taskController: false, approvalMode: 'auto', maxModelCalls: 4, maxTurns: 30 })
  const conv = await host.createConversation(), first = await host.sendMessage(conv.id, { text: 'Inspect this workspace and report the files.' })
  expect((await first.outcome()).error?.code).toBe('TASK_MODEL_CALL_BUDGET_EXHAUSTED')
  return { dir, host, conv, first, calls: () => calls }
}
it('continues the original task with 256 calls and makes repeated confirmations idempotent', async () => {
  const f = await exhaustedHost()
  try {
    const offer = await f.host.describeBudgetContinuation(f.conv.id)
    expect(offer).toMatchObject({ runId: f.first.id, used: 4, limit: 4, totalUsed: 4, calls: 256, status: 'available' })
    const parentPath = join(f.dir, 'data/conversations', f.conv.id, 'runs', f.first.id, 'model-budget.json'), before = await readFile(parentPath, 'utf8')
    const renewal = { sourceRunId: f.first.id, expectedUsed: 4, expectedLimit: 4, confirmed: true as const }
    const next = await f.host.sendMessage(f.conv.id, { text: '继续完成原任务', budgetRenewal: renewal })
    expect(next.id).toBe(offer!.continuationRunId)
    expect((await next.outcome()).status).toBe('succeeded')
    const path = join(f.dir, 'data/conversations', f.conv.id, 'runs', next.id)
    const budget = await ModelAttemptBudget.read(join(path, 'model-budget.json'))
    expect(budget.limit).toBe(256); expect(budget.used).toBeGreaterThan(0)
    expect(JSON.parse(await readFile(join(path, 'input.json'), 'utf8')).goal).toContain('Inspect this workspace')
    expect(await readFile(parentPath, 'utf8')).toBe(before)
    const calls = f.calls()
    await expect(f.host.sendMessage(f.conv.id, { text: '继续完成原任务', budgetRenewal: renewal })).rejects.toThrow(`BUDGET_ALREADY_CONTINUED:${next.id}`)
    expect(f.calls()).toBe(calls)
    expect((await f.host.describeBudgetContinuation(f.conv.id, f.first.id))?.status).toBe('continued')
  } finally { await f.host.close(); vi.unstubAllGlobals() }
}, 15000)

it('requires explicit HTTP confirmation, deduplicates concurrent grants and remembers them after restart', async () => {
  const f = await exhaustedHost()
  let host = f.host, server = new H5Server(host, { dataDir: join(f.dir, 'data'), port: 0, host: '127.0.0.1' })
  const connect = async () => {
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`
    const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    return { base, headers: { Cookie: session.headers.get('set-cookie')!, Origin: base, 'Content-Type': 'application/json' } }
  }
  try {
    let { base, headers } = await connect()
    const route = `/api/conversations/${f.conv.id}/runs/${f.first.id}/budget-continuation`
    const body = { confirmed: true, expectedUsed: 4, expectedLimit: 4 }
    expect((await fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ ...body, confirmed: false }) })).status).toBe(400)
    expect((await fetch(base + route, { method: 'POST', headers: { ...headers, Origin: 'http://other.invalid' }, body: JSON.stringify(body) })).status).toBe(403)
    expect((await fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ ...body, expectedUsed: 3 }) })).status).toBe(409)
    expect(f.calls()).toBe(4)
    const responses = await Promise.all([1, 2].map(() => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })))
    for (const response of responses) expect(response.status).toBe(200)
    const [a, b] = await Promise.all(responses.map(response => response.json()))
    expect(a.runId).toBe(b.runId)
    await vi.waitFor(async () => expect((await host.getConversation(f.conv.id)).summary.activeRunId).toBeUndefined())
    const calls = f.calls()
    await server.stop(); await host.close()
    host = createLocalHost({ cwd: f.dir, dataDir: join(f.dir, 'data'), provider: { provider: 'mock' }, taskController: false })
    server = new H5Server(host, { dataDir: join(f.dir, 'data'), port: 0, host: '127.0.0.1' })
    ;({ base, headers } = await connect())
    const retry = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })
    expect(retry.status).toBe(200); expect(await retry.json()).toEqual({ runId: a.runId, duplicate: true })
    expect(f.calls()).toBe(calls)
  } finally { await server.stop(); await host.close(); vi.unstubAllGlobals() }
}, 20000)

it('passes the confirmed allowance through the real isolated CLI worker without resetting the parent', async () => {
  const f = await exhaustedHost()
  let worker: Awaited<ReturnType<typeof startH5WorkWorker>> | undefined
  try {
    const parentPath = join(f.dir, 'data/conversations', f.conv.id, 'runs', f.first.id, 'model-budget.json'), before = await readFile(parentPath, 'utf8')
    const configPath = join(f.dir, 'worker-config.json')
    await writeFile(configPath, JSON.stringify({ providers: { mock: { provider: 'mock', name: 'Mock' } }, models: { mock: { displayName: 'mock', provider: 'mock', modelCode: 'mock' } }, activeModel: 'mock' }))
    worker = await startH5WorkWorker({ entry: fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)), dataDir: join(f.dir, 'data'), configPath, cwd: f.dir, runtimeOptions: { cwd: f.dir, dataDir: join(f.dir, 'data'), provider: { provider: 'mock' }, taskController: false, mockResponse: 'Finished in the worker', maxModelCalls: 4, frontModel: { enabled: false }, jarvis: { enabled: false } } }, { conversationId: f.conv.id, text: '继续完成原任务', budgetRenewal: { sourceRunId: f.first.id, expectedUsed: 4, expectedLimit: 4, confirmed: true } })
    const outcome = await worker.outcome(); expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded')
    const child = await ModelAttemptBudget.read(join(f.dir, 'data/conversations', f.conv.id, 'runs', worker.id, 'model-budget.json'))
    expect(child.limit).toBe(256); expect(child.accounting.renewal).toMatchObject({ sourceRunId: f.first.id, confirmed: true })
    expect(await readFile(parentPath, 'utf8')).toBe(before)
  } finally { await worker?.shutdown?.(); await f.host.close(); vi.unstubAllGlobals() }
}, 20000)

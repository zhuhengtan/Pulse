import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hash, save, load, manifest } from './long-task-lib.mjs'

test('disposable real Host worker counts fake HTTP attempts and stops without creating another run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-long-task-transport-')), caseDir = join(root, 'LT01'), workspace = join(caseDir, 'workspace')
  let requests = 0
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.reasoning_effort, 'low'); assert.equal(body.model, 'deepseek-flash')
    requests++
    // Progress on every round, to exercise the hard budget rather than loop detection.
    const tool = { index: 0, id: `call-${requests}`, type: 'function', function: { name: 'plan_write', arguments: JSON.stringify({ path: `docs/plans/artifact-${requests}.md`, content: `# Plan revision ${requests}` }) } }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await mkdir(workspace, { recursive: true })
    const config = join(root, 'fake-config.json')
    save(config, { activeModel: 'deepseek/deepseek-flash', providers: { deepseek: { provider: 'deepseek', apiKeyEnv: 'PULSE_EVAL_TEST_API_KEY', baseURL: `http://127.0.0.1:${server.address().port}`, models: { 'deepseek-flash': { modelCode: 'deepseek-flash' } } } } })
    save(join(root, 'frozen.json'), { workerHash: hash(await readFile(new URL('./long-task-worker.mjs', import.meta.url))), dataset: { limits: { perSampleMs: 30000 }, tasks: [{ id: 'LT01', effort: 'low', prompt: '/grill-and-plan 为文档制作计划，等待最终确认。' }] } })
    save(join(root, 'budget.json'), { totalLimit: 96, sampleLimit: 16, used: 0, samples: { LT01: 0 } })
    save(join(caseDir, 'before.json'), await manifest(workspace))
    save(join(caseDir, 'started.json'), { at: new Date().toISOString() })
    const exit = await new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, [new URL('./long-task-worker.mjs', import.meta.url).pathname, root, 'LT01'], { env: { ...process.env, PULSE_CONFIG: config, PULSE_EVAL_TEST_API_KEY: 'fake-local-only' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''; worker.stderr.on('data', chunk => { stderr += chunk }); worker.stdout.resume()
      worker.on('error', reject); worker.on('exit', code => resolve({ code, stderr }))
    })
    assert.equal(exit.code, 0, exit.stderr)
    const result = load(join(caseDir, 'result.json'))
    assert.equal(requests, 16)
    assert.equal(result.outerAttempts, requests)
    assert.equal(load(join(root, 'budget.json')).used, requests)
    assert.equal(result.usage.modelCalls, requests)
    assert.equal(result.outcome.error?.code, 'TASK_MODEL_CALL_BUDGET_EXHAUSTED')
    console.log(JSON.stringify({ fakeRequests: requests, result: result.outcome.status, error: result.outcome.error?.code }))
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})

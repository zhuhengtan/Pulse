import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hash, save, load } from './long-task-lib.mjs'

test('supervisor halts after the first fake provider failure and cannot skip it on restart', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pulse-supervisor-stop-'))
  let calls = 0
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain local fake payload */ }
    calls++; response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'offline simulated unavailable' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const config = join(out, 'config.json')
    save(config, { activeModel: 'deepseek/flash', providers: { deepseek: { provider: 'deepseek', apiKeyEnv: 'PULSE_EVAL_TEST_API_KEY', baseURL: `http://127.0.0.1:${server.address().port}`, models: { flash: { modelCode: 'deepseek-flash' } } } } })
    const tasks = [{ id: 'LT01', effort: 'low', prompt: 'Explain this local project without changing files.' }, { id: 'LT02', effort: 'high', prompt: 'Must never dispatch this sample.' }]
    for (const task of tasks) { await mkdir(join(out, task.id, 'workspace'), { recursive: true }); save(join(out, task.id, 'before.json'), {}) }
    save(join(out, 'budget.json'), { totalLimit: 32, sampleLimit: 16, used: 0, samples: { LT01: 0, LT02: 0 } })
    save(join(out, 'preflight.json'), { authenticated: true, modelAvailable: true })
    save(join(out, 'frozen.json'), { workerHash: hash(await readFile(new URL('./long-task-worker.mjs', import.meta.url))), libHash: hash(await readFile(new URL('./long-task-lib.mjs', import.meta.url))), graderHash: hash(await readFile(new URL('./long-task-grade.mjs', import.meta.url))), dataset: { limits: { perSampleCalls: 16, totalCalls: 32, perSampleMs: 30000 }, tasks } })
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [new URL('./long-tasks.mjs', import.meta.url).pathname, 'run', '--out', out], { env: { ...process.env, PULSE_CONFIG: config, PULSE_EVAL_TEST_API_KEY: 'fake-local-only' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk }); child.on('error', reject); child.on('exit', code => resolve({ code, output }))
    })
    const first = await run()
    assert.notEqual(first.code, 0, first.output)
    const summary = JSON.parse(first.output.split('\n').find(line => line.startsWith('{"finished":')))
    assert.equal(summary.finished, false)
    assert.equal(summary.blocked, true)
    assert.equal(calls, 1)
    assert.equal(load(join(out, 'budget.json')).used, 1)
    assert.match(load(join(out, 'blocked.json')).reason, /PROVIDER_HTTP_503/)
    await assert.rejects(access(join(out, 'LT02/started.json')))
    const reopened = await run()
    assert.notEqual(reopened.code, 0)
    assert.match(reopened.output, /PREVIOUS_SAMPLE_BLOCKS_BATCH/)
    assert.equal(calls, 1)
  } finally { await new Promise(resolve => server.close(resolve)); await rm(out, { recursive: true, force: true }) }
})

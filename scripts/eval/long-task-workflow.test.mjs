import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash, save, load } from './long-task-lib.mjs'

const cli = async (script, args, env) => await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  child.on('error', reject); child.on('exit', code => resolve({ code, output }))
})
const tool = (name, input) => ({ content: '', tool_calls: [{ id: 'fixture-call', function: { name, arguments: JSON.stringify(input) } }] })

test('actual supervisor cold-restarts the same Host at parenthesized hold/execute and defers without implementation (local fake provider)', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pulse-grill-supervisor-'))
  const plan = '# Local scenario evaluation plan\n\n' + '逐例报告、汇总、矩阵、问题清单；保留文件；确认后才执行。\n'.repeat(80)
  let story = 0, calls = 0
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls++
    let message
    if (JSON.stringify(body.messages).includes('Pulse safety reviewer')) message = { content: 'APPROVE' }
    else if (JSON.stringify(body.messages).includes('Summarize the older conversation')) message = { content: 'Existing plan preserved; v2 saved. Confirmed name choice v2. Final defer is pending. Do not repeat writes or the interview.' }
    else {
      story++
      message = [
        () => tool('fs_read', { path: 'docs/plans/pulse-long-task-evaluation.md' }),
        () => tool('ask_choice', { prompt: '同名文件已存在，请选择新路径', options: [{ label: 'docs/plans/pulse-long-task-evaluation-v2.md，保留原文件', value: 'v2' }, { label: '停止', value: 'stop' }] }),
        () => tool('plan_write', { path: 'docs/plans/pulse-long-task-evaluation-v2.md', content: plan }),
        () => tool('fs_read', { path: 'docs/plans/pulse-long-task-evaluation-v2.md' }),
        () => tool('ask_choice', { prompt: '计划已保存，选择下一步', options: [{ label: '暂不执行（默认，保留计划）', value: 'hold' }, { label: '执行（开始实施）', value: 'execute' }] }),
      ][story - 1]?.() ?? { content: '计划已保存，暂不执行。' }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { ...message, reasoning_content: '' }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const dir = join(out, 'LT06'), workspace = join(dir, 'workspace')
    await mkdir(join(workspace, 'docs/plans'), { recursive: true }); await mkdir(join(workspace, 'fixtures'))
    await import('node:fs/promises').then(({ writeFile }) => Promise.all([
      writeFile(join(workspace, 'docs/plans/pulse-long-task-evaluation.md'), '# Existing approved user plan\nPreserve this file; never overwrite.\n'),
      writeFile(join(workspace, 'fixtures/evaluation-request.md'), '只形成计划，最终暂不执行。'),
    ]))
    const { manifest } = await import('./long-task-lib.mjs'); save(join(dir, 'before.json'), await manifest(workspace))
    const config = join(out, 'config.json'); save(config, { activeModel: 'deepseek/flash', providers: { deepseek: { provider: 'deepseek', apiKeyEnv: 'PULSE_EVAL_TEST_API_KEY', baseURL: `http://127.0.0.1:${server.address().port}`, models: { flash: { modelCode: 'deepseek-flash' } } } } })
    save(join(out, 'budget.json'), { totalLimit: 16, sampleLimit: 16, used: 0, samples: { LT06: 0 } })
    save(join(out, 'preflight.json'), { authenticated: true, modelAvailable: true })
    save(join(out, 'frozen.json'), { workerHash: hash(await readFile(new URL('./long-task-worker.mjs', import.meta.url))), libHash: hash(await readFile(new URL('./long-task-lib.mjs', import.meta.url))), graderHash: hash(await readFile(new URL('./long-task-grade.mjs', import.meta.url))), dataset: { limits: { perSampleCalls: 16, totalCalls: 16, perSampleMs: 20000 }, tasks: [{ id: 'LT06', effort: 'high', prompt: '/grill-and-plan 检查已有计划，形成新计划，最终明确选择是否执行，不提前实现。' }] } })
    const result = await cli('./long-tasks.mjs', ['run', '--out', out], { PULSE_CONFIG: config, PULSE_EVAL_TEST_API_KEY: 'local-fake-only' })
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /cold restart at final confirmation/)
    const restored = load(join(dir, 'restore.json'))
    assert.equal(restored.sameRun, true); assert.equal(restored.samePending, true); assert.equal(restored.callsBefore, restored.callsAfterRestore)
    assert.deepEqual(load(join(dir, 'result.json')).changed, ['docs/plans/pulse-long-task-evaluation-v2.md'])
    assert.equal(await readFile(join(workspace, 'docs/plans/pulse-long-task-evaluation-v2.md'), 'utf8'), plan)
    assert.equal(load(join(out, 'budget.json')).used, calls)
    assert.ok(calls <= 16)
    const interaction = (await readFile(join(dir, 'interactions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).find(row => row.kind === 'final-answer-after-cold-restore')
    assert.deepEqual(interaction.nativeValue, { value: 'hold' })
    const { gradeCase } = await import('./long-task-grade.mjs')
    const grade = await gradeCase(out, { id: 'LT06', deliverables: ['docs/plans/pulse-long-task-evaluation-v2.md'] })
    assert.equal(grade.checks.every(row => row.passed), true, JSON.stringify(grade.checks))
    // This test must never dispatch the implementation continuation.
    assert.equal(story, 5)
  } finally { await new Promise(resolve => server.close(resolve)); await rm(out, { recursive: true, force: true }) }
})

test('an expired restore fails before any provider admission or automatic reply', async () => {
  const out = await mkdtemp(join(tmpdir(), 'pulse-expired-grill-'))
  try {
    const dir = join(out, 'LT06'); await mkdir(join(dir, 'workspace'), { recursive: true })
    save(join(dir, 'before.json'), {}); save(join(dir, 'started.json'), { at: '2020-01-01T00:00:00.000Z' })
    save(join(out, 'budget.json'), { totalLimit: 16, sampleLimit: 16, used: 0, samples: { LT06: 0 } })
    save(join(out, 'frozen.json'), { workerHash: hash(await readFile(new URL('./long-task-worker.mjs', import.meta.url))), dataset: { limits: { perSampleCalls: 16, perSampleMs: 1000 }, tasks: [{ id: 'LT06', effort: 'high' }] } })
    const config = join(out, 'config.json'); save(config, { activeModel: 'deepseek/flash', providers: { deepseek: { provider: 'deepseek', apiKeyEnv: 'PULSE_EVAL_TEST_API_KEY', baseURL: 'http://127.0.0.1:1', models: { flash: { modelCode: 'deepseek-flash' } } } } })
    const result = await cli('./long-task-worker.mjs', [out, 'LT06', '--restore'], { PULSE_CONFIG: config, PULSE_EVAL_TEST_API_KEY: 'local-fake-only' })
    assert.notEqual(result.code, 0)
    assert.equal(load(join(dir, 'result.json')).error.code, 'EVALUATION_DEADLINE')
    assert.equal(load(join(out, 'budget.json')).used, 0)
  } finally { await rm(out, { recursive: true, force: true }) }
})

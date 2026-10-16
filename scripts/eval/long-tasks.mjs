#!/usr/bin/env node
import { mkdir, readFile, cp, readdir, writeFile, open, unlink } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gradeCase } from './long-task-grade.mjs'
import { prepareEvaluationSupport, probeEvaluationEnvironment } from './long-task-support.mjs'
import { hash, load, save, manifest, officialNotes, ownerFacts, evaluationBlockReason } from './long-task-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const output = resolve(option('--out', join(root, '.pulse-dev/long-task-eval-20261015')))
const datasetPath = join(root, 'evals/long-tasks.v1.json'), dataset = load(datasetPath)
if (dataset.tasks.length !== 6 || dataset.tasks.filter(t => t.effort === 'low').length !== 3 || dataset.tasks.filter(t => t.effort === 'high').length !== 3) throw new Error('INVALID_FROZEN_DATASET')
const rawCalls = option('--sample-calls', '16')
const perSampleCalls = ['none', 'null'].includes(rawCalls) ? null : Number(rawCalls)
const selectedTask = option('--task', undefined)
if (selectedTask) { dataset.tasks = dataset.tasks.filter(t => t.id === selectedTask); if (!dataset.tasks.length) throw new Error('UNKNOWN_EVAL_TASK') }
if (args.includes('--no-deadline')) dataset.limits.perSampleMs = null
if (perSampleCalls !== null && (!Number.isInteger(perSampleCalls) || perSampleCalls < 4 || perSampleCalls > 256)) throw new Error('INVALID_SAMPLE_BUDGET')
dataset.limits.perSampleCalls = perSampleCalls; dataset.limits.totalCalls = perSampleCalls === null ? null : perSampleCalls * dataset.tasks.length
const command = args[0] ?? '--help'
if (command === 'prepare') {
  await mkdir(output, { recursive: false })
  const source = join(output, 'source'); await mkdir(source)
  const excluded = new Set(['node_modules', '.git', '.pulse-dev', 'dist', 'web-dist', 'long-tasks.mjs', 'long-task-worker.mjs', 'long-task-acceptance.mjs', 'long-task-resume-probe.mjs', 'long-task-resume-probe.test.mjs', 'long-task-support.mjs', 'long-task-support.test.mjs', 'lt02-real-regression.json', 'lt02-repaired-regression.json', 'long-task-lt02-regression.test.mjs', 'long-task-lib.mjs', 'long-task-grade.mjs', 'long-task-calibration.test.mjs', 'long-tasks.v1.json'])
  const fixtureSource = resolve(option('--fixture-source', root))
  for (const path of ['packages', 'scripts', 'docs', 'evals', 'tests', 'package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'README.md', 'README.en.md']) {
    await cp(join(fixtureSource, path), join(source, path), { recursive: true, filter: path => !excluded.has(path.split('/').at(-1)) && !/^lt02-.*regression\.json$/.test(path.split('/').at(-1)) && !/\.(?:pem|key|p12|pfx|crt)$/i.test(path) && !path.includes('/docs/reviews/') })
  }
  const audit = load(join(root, '.pulse-dev/repair-run-audit-20261014.json'))
  const continuation = load(join(root, '.pulse-dev/continuation-audit-20261014.json'))
  const records = audit.map(row => ({ runId: row.runId, createdAt: row.createdAt, status: row.status, error: row.error, usage: row.usage, source: '.pulse-dev/repair-run-audit-20261014.json' }))
  records.push({ runId: continuation.runId, status: continuation.status, error: continuation.error, usage: continuation.usage, source: '.pulse-dev/continuation-audit-20261014.json' })
  records.push(structuredClone(records[0]))
  await mkdir(join(source, 'fixtures'), { recursive: true })
  save(join(source, 'fixtures/run-records.json'), records)
  await writeFile(join(source, 'fixtures/deepseek-official-notes.md'), officialNotes)
  await writeFile(join(source, 'fixtures/evaluation-request.md'), '# 用户已确认的要求\n\n' + (perSampleCalls === null ? '本轮只执行所选场景，不设额外评测调用/token/费用上限；保留产品256次硬上限及安全机制。' : ownerFacts.replace('每例最多16次', `每例最多${perSampleCalls}次`).replace('最多96次', `最多${perSampleCalls * dataset.tasks.length}次`)) + '\n报告组织方式已确认：每例独立报告，另有汇总、矩阵和问题清单；仅对仍会改变方案的信息逐题澄清。\n')
  const sourceManifest = await manifest(source)
  const support = {}
  for (const task of dataset.tasks) {
    const caseDir = join(output, task.id), workspace = join(caseDir, 'workspace')
    await mkdir(caseDir)
    await cp(source, workspace, { recursive: true })
    if (task.id === 'LT02') { support[task.id] = await prepareEvaluationSupport(workspace); await probeEvaluationEnvironment(workspace, join(caseDir, 'environment-check')) }
    if (task.id === 'LT06') {
      await mkdir(join(workspace, 'docs/plans'), { recursive: true })
      await writeFile(join(workspace, 'docs/plans/pulse-long-task-evaluation.md'), '# Existing approved user plan\nPreserve this file; never overwrite.\n')
    }
    execFileSync('git', ['init', '-q', workspace])
    save(join(caseDir, 'before.json'), await manifest(workspace))
  }
  save(join(output, 'budget.json'), { schemaVersion: 1, totalLimit: dataset.limits.totalCalls, sampleLimit: dataset.limits.perSampleCalls, used: 0, samples: Object.fromEntries(dataset.tasks.map(task => [task.id, 0])) })
  save(join(output, 'frozen.json'), { frozenAt: new Date().toISOString(), support, supportHash: hash(await readFile(join(root, 'scripts/eval/long-task-support.mjs'))), dataset, datasetHash: hash(await readFile(datasetPath)), workerHash: hash(await readFile(join(root, 'scripts/eval/long-task-worker.mjs'))), libHash: hash(await readFile(join(root, 'scripts/eval/long-task-lib.mjs'))), graderHash: hash(await readFile(join(root, 'scripts/eval/long-task-grade.mjs'))), probeHash: hash(await readFile(join(root, 'scripts/eval/long-task-probe.mjs'))), resumeProbeHash: hash(await readFile(join(root, 'scripts/eval/long-task-resume-probe.mjs'))), acceptanceHash: hash(await readFile(join(root, 'scripts/eval/long-task-acceptance.mjs'))), sourceManifest, dirtyBaseline: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), limits: dataset.limits })
  console.log(JSON.stringify({ prepared: output, tasks: dataset.tasks.map(({ id, effort, title }) => ({ id, effort, title })), sourceFiles: Object.keys(sourceManifest).length, realCalls: 0 }))
} else if (command === 'preflight') {
  const config = load(process.env.PULSE_CONFIG ?? '/Users/zhuhengtan/.pulse/config.json')
  const [providerId, modelId] = (config.activeModel ?? '').split('/'), profile = config.providers?.[providerId], model = profile?.models?.[modelId]
  const key = process.env[profile?.apiKeyEnv ?? 'DEEPSEEK_API_KEY']
  if (profile?.provider !== 'deepseek' || !model?.modelCode || !key) throw new Error('CONFIG_OR_CREDENTIAL_UNAVAILABLE')
  const started = Date.now()
  try {
    const response = await fetch(`${(profile.baseURL ?? 'https://api.deepseek.com').replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) })
    const body = await response.json(), found = body.data?.some(item => item.id === model.modelCode)
    const result = { at: new Date().toISOString(), authenticated: response.ok, modelAvailable: !!found, model: model.modelCode, status: response.status, durationMs: Date.now() - started, generationCalls: 0 }
    save(join(output, 'preflight.json'), result); console.log(JSON.stringify(result)); if (!response.ok || !found) process.exitCode = 1
  } catch (error) { save(join(output, 'preflight.json'), { at: new Date().toISOString(), code: error.cause?.code ?? error.code ?? error.name, generationCalls: 0 }); process.exitCode = 1 }
} else if (command === 'run') {
  const frozen = load(join(output, 'frozen.json')), preflight = load(join(output, 'preflight.json'))
  if (!preflight.authenticated || !preflight.modelAvailable) throw new Error('PREFLIGHT_FAILED')
  for (const [name, expected] of [['long-task-worker.mjs', frozen.workerHash], ['long-task-lib.mjs', frozen.libHash], ['long-task-grade.mjs', frozen.graderHash]]) if (hash(await readFile(join(root, 'scripts/eval', name))) !== expected) throw new Error(`FROZEN_INFRASTRUCTURE_CHANGED: ${name}`)
  if (frozen.supportHash && hash(await readFile(join(root, 'scripts/eval/long-task-support.mjs'))) !== frozen.supportHash) throw new Error('FROZEN_INFRASTRUCTURE_CHANGED: long-task-support.mjs')
  if (frozen.probeHash && hash(await readFile(join(root, 'scripts/eval/long-task-probe.mjs'))) !== frozen.probeHash) throw new Error('FROZEN_INFRASTRUCTURE_CHANGED: long-task-probe.mjs')
  if (frozen.resumeProbeHash && hash(await readFile(join(root, 'scripts/eval/long-task-resume-probe.mjs'))) !== frozen.resumeProbeHash) throw new Error('FROZEN_INFRASTRUCTURE_CHANGED: long-task-resume-probe.mjs')
  if (frozen.acceptanceHash && hash(await readFile(join(root, 'scripts/eval/long-task-acceptance.mjs'))) !== frozen.acceptanceHash) throw new Error('FROZEN_INFRASTRUCTURE_CHANGED: long-task-acceptance.mjs')
  const lockPath = join(output, 'supervisor.lock')
  const lock = await open(lockPath, 'wx', 0o600)
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  try {
  let batchBlocked = false
  for (const task of frozen.dataset.tasks) {
    const caseDir = join(output, task.id)
    if ((await readdir(caseDir)).includes('result.json')) {
      const blocked = evaluationBlockReason(load(join(caseDir, 'result.json')))
      if (blocked) throw new Error(`PREVIOUS_SAMPLE_BLOCKS_BATCH: ${task.id}: ${blocked}`)
      console.log(`${task.id}: previous result retained`); continue
    }
    if ((await readdir(caseDir)).includes('started.json')) throw new Error(`INTERRUPTED_SAMPLE_REQUIRES_AUDIT: ${task.id}`)
    save(join(caseDir, 'started.json'), { at: new Date().toISOString() })
    const deadline = frozen.dataset.limits.perSampleMs === null ? null : Date.now() + frozen.dataset.limits.perSampleMs
    async function worker(restore = false) {
      return new Promise((res, rej) => {
        const child = spawn(process.execPath, [join(root, 'scripts/eval/long-task-worker.mjs'), output, task.id, ...(restore ? ['--restore'] : [])], { cwd: root, stdio: 'inherit' })
        const timer = deadline === null ? undefined : setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref() }, Math.max(1, deadline - Date.now()))
        child.on('error', rej); child.on('exit', (code, signal) => { if (timer) clearTimeout(timer); res({ code, signal }) })
      })
    }
    console.log(`${task.id}: start ${task.effort}`)
    let exit = await worker()
    if (exit.code === 75 && task.id === 'LT06') { console.log('LT06: cold restart at final confirmation'); exit = await worker(true) }
    if (!(await readdir(caseDir)).includes('result.json')) save(join(caseDir, 'result.json'), { taskId: task.id, effort: task.effort, error: { code: 'WORKER_EXIT', ...exit }, outerAttempts: load(join(output, 'budget.json')).samples[task.id] })
    console.log(`${task.id}: end; cumulative calls ${load(join(output, 'budget.json')).used}/${frozen.dataset.limits.totalCalls}`)
    if (task.id === 'LT02') {
      try { save(join(caseDir, 'grade.json'), await gradeCase(output, task)) } catch (error) { save(join(caseDir, 'grade.json'), { taskId: task.id, independentAcceptance: 'unavailable', error: String(error.message), requiresManualAcceptance: true }) }
    }
    const blocked = evaluationBlockReason(load(join(caseDir, 'result.json')))
    if (blocked) {
      save(join(output, 'blocked.json'), { at: new Date().toISOString(), taskId: task.id, reason: blocked, budget: load(join(output, 'budget.json')) })
      console.log(`Batch stopped: ${blocked}; no further samples dispatched`)
      process.exitCode = 1
      batchBlocked = true
      break
    }
  }
  console.log(JSON.stringify({ finished: !batchBlocked, blocked: batchBlocked, budget: load(join(output, 'budget.json')) }))
  } finally { await lock.close(); await unlink(lockPath) }
} else {
  console.log('node scripts/eval/long-tasks.mjs prepare|preflight|run --out <new evaluation directory>\nOffline: node --test scripts/eval/long-task-calibration.test.mjs\nIndependent grade: node scripts/eval/long-task-grade.mjs <evaluation directory>')
}

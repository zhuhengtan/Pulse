import assert from 'node:assert/strict'
import { cp, mkdir, symlink, readFile, writeFile, realpath, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runShell } from '../../packages/adapters/dist/tools/shell.js'
import { manifest, hash, save } from './long-task-lib.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const packages = ['runtime', 'adapters', 'server', 'tool-sdk']

/** Installed dependencies, never task implementation or candidate tests. Fresh copies only. */
export async function prepareEvaluationSupport(workspace) {
  await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const pkg of packages) {
    const target = join(workspace, 'packages', pkg)
    await mkdir(target, { recursive: true })
    await cp(join(root, 'packages', pkg, 'dist'), join(target, 'dist'), { recursive: true, force: false, errorOnExist: true })
    await symlink(join(root, 'packages', pkg, 'node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  return evaluationSupportManifest(workspace)
}

export async function evaluationSupportManifest(workspace) {
  const files = {}
  for (const pkg of packages) for (const [name, value] of Object.entries(await manifest(join(workspace, 'packages', pkg, 'dist')))) files[`packages/${pkg}/dist/${name}`] = value
  for (const name of ['node_modules', ...packages.map(p => `packages/${p}/node_modules`)]) files[name] = await realpath(join(workspace, name))
  return files
}

/** No provider: prove the candidate can run its real grader before paid work starts. */
export async function probeEvaluationEnvironment(workspace, destination) {
  await mkdir(destination, { recursive: false })
  const probe = await mkdtemp(join(workspace, '.pulse-environment-check-'))
  try {
    const dataset = JSON.parse(await readFile(join(root, 'evals/tasks.v1.json'), 'utf8'))
    for (const task of dataset.tasks) { task.scoring = { method: 'artifact', maxPoints: 1, checks: [{ type: 'fileExists', path: 'result.txt', points: 1 }] }; task.sideEffects.network = false }
    await writeFile(join(probe, 'dataset.json'), JSON.stringify(dataset))
    await writeFile(join(probe, 'config.json'), JSON.stringify({ providers: { local: { provider: 'ollama' } }, models: { fixture: { provider: 'local', modelCode: 'fixture', maxContextTokens: 32000 } } }))
    await writeFile(join(probe, 'fake-cli.mjs'), `import{writeFileSync}from'node:fs';import{join}from'node:path';const a=process.argv.slice(2);writeFileSync(join(a[a.indexOf('--cwd')+1],'result.txt'),'offline');console.log(JSON.stringify({type:'result',runId:'run-offline',status:'succeeded',taskOutcome:{status:'accepted'},usage:{modelCalls:1,inputTokens:10,outputTokens:2,providerCosts:[],completeness:'complete'}}));`)
    const output = join(probe, 'out')
    const result = await runShell('node', [join(workspace, 'scripts/eval/run.mjs'), '--dataset', join(probe, 'dataset.json'), '--cli', join(probe, 'fake-cli.mjs'), '--config', join(probe, 'config.json'), '--model', 'fixture', '--task', 'code-01', '--trials', '1', '--max-turns', '1', '--max-model-calls', '1', '--max-total-tokens', '10000000', '--out', output, '--auto-approve'], { cwd: workspace, env: { PATH: process.env.PATH }, timeoutMs: 60000, maxOutputBytes: 1000000 })
    save(join(destination, 'sandbox-run.json'), result)
    assert.equal(result.code, 0, result.stderr + result.stdout)
    assert.equal(result.timedOut || result.aborted || result.truncated, false)
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
    assert.equal(report.tasksRun, 1)
    assert.equal(report.records[0].status, 'succeeded')
    assert.equal(report.records[0].grading.passed, true, JSON.stringify(report.records[0].grading))
    const receipt = { passed: true, generationCalls: 0, sandboxed: true, grader: 'actual compiled artifact grader', runnerHash: hash(await readFile(join(workspace, 'scripts/eval/run.mjs'))), stdout: result.stdout }
    save(join(destination, 'result.json'), receipt)
    return receipt
  } finally {
    try { await cp(probe, destination, { recursive: true, force: false, errorOnExist: true }) }
    finally { await rm(probe, { recursive: true, force: true }) }
  }
}

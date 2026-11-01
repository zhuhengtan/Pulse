import { appendFileSync, readFileSync } from 'node:fs'
export function verifyExecution(plan, files, collectedModes) {
  const actual = files.map(file => file.filepath.replaceAll('\\', '/')).sort()
  const expected = plan.files.map(file => `${plan.root.replaceAll('\\', '/')}/${file}`).sort()
  if (!expected.length || actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some((file, index) => file !== expected[index])) throw Error('TEST_EXECUTION_COVERAGE_MISMATCH')
  let passed = 0, skipped = 0
  function visit(task, inheritedSkip = false) {
    const mode = collectedModes?.get(task.id) ?? task.mode
    const allowedSkip = inheritedSkip || mode === 'skip' || mode === 'todo'
    if (task.tasks) { for (const child of task.tasks) visit(child, allowedSkip); return }
    if (task.result?.state === 'pass') passed++
    else if (allowedSkip) skipped++
    else throw Error('TEST_EXECUTION_INCOMPLETE:' + task.name)
  }
  for (const file of files) visit(file)
  return { files: actual.length, passed, skipped }
}
export default class CIReporter {
  constructor() { this.tasks = new Map(); this.started = new Set(); this.finished = new Set(); this.modes = new Map() }
  onCollected(files) {
    const visit = (task, prefix) => { this.tasks.set(task.id, prefix + task.name); this.modes.set(task.id, task.mode); for (const child of task.tasks ?? []) visit(child, prefix + task.name + ' > ') }
    for (const file of files) visit(file, '')
  }
  onTaskUpdate(packs) {
    for (const [id, result] of packs) {
      const name = this.tasks.get(id) ?? id
      if (result?.state === 'run' && !this.started.has(id)) { this.started.add(id); console.log('[ci:test] start ' + name) }
      if (result?.state === 'fail' && !this.finished.has(id)) {
        this.finished.add(id)
        console.error('[ci:test] FAIL ' + name)
        for (const error of result.errors ?? []) console.error(String(error.message ?? error).slice(0, 4000))
      }
    }
  }
  onFinished(files, errors = []) {
    const planFile = process.env.PULSE_CI_TEST_PLAN
    if (!planFile) return
    const plan = JSON.parse(readFileSync(planFile, 'utf8'))
    const failed = errors.length || files.some(file => file.result?.state === 'fail')
    if (failed) { console.error('[ci:coverage] incomplete: test failure; no full-gate receipt'); return }
    try {
      const result = verifyExecution(plan, files, this.modes)
      console.log('[ci:coverage] ' + JSON.stringify({ inventoryHash: plan.inventoryHash, shard: plan.shard, ...result }))
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nBackend ${plan.shard ? 'shard ' + plan.shard + '/4' : 'full'}: ${result.files} files, ${result.passed} passed, ${result.skipped} declared skipped. Inventory: ${plan.inventoryHash}\n`)
    } catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}

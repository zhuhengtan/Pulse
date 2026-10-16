import { readFile, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeResumeIntegration } from './long-task-resume-probe.mjs'
import { evaluationSupportManifest } from './long-task-support.mjs'
import { probeRunnerIntegration } from './long-task-probe.mjs'
import { runShell } from '../../packages/adapters/dist/tools/shell.js'
import { load, save, manifest, changes } from './long-task-lib.mjs'

export async function gradeCase(output, task) {
  const caseDir = join(output, task.id), workspace = join(caseDir, 'workspace'), result = load(join(caseDir, 'result.json'))
  const checks = []
  const check = (name, passed, detail = '') => checks.push({ name, passed: !!passed, detail })
  const text = async path => { try { if ((await lstat(join(workspace, path))).isSymbolicLink()) return ''; return await readFile(join(workspace, path), 'utf8') } catch { return '' } }
  const changed = changes(load(join(caseDir, 'before.json')), await manifest(workspace))
  for (const path of task.deliverables) check(`产物: ${path}`, (await text(path)).length > 0 && changed.includes(path), 'requires new or changed content')
  async function behavior(name, code) {
    try {
      const probe = await runShell('node', ['--input-type=module', '-e', code], { cwd: workspace, timeoutMs: 30000, maxOutputBytes: 12000, env: { PATH: process.env.PATH, PNPM_HOME: process.env.PNPM_HOME } })
      check(name, probe.code === 0 && !probe.timedOut && !probe.truncated, JSON.stringify(probe))
    } catch (error) { check(name, false, error.code ?? error.message); if (/SANDBOX_(?:SETUP|CLEANUP)_FAILED/.test(error.code ?? error.message)) checks.at(-1).status = 'blocked_env' }
  }
  if (task.id === 'LT01') {
    await behavior('新旧模型解析、非法引用和真实调用参数', `import assert from 'node:assert/strict'; const {resolveEvaluationModel:r,buildEvaluationArgs:b}=await import('./scripts/eval/config-budget.mjs'); const p={provider:'deepseek',models:{flash:{modelCode:'deepseek-flash'}}}; assert.equal(r({providers:{ds:p}},'ds/flash').modelCode,'deepseek-flash'); assert.equal(r({providers:{ds:p}},'ds/flash').providerCode,'ds'); assert.equal(r({providers:{ds:{provider:'deepseek'}},models:{legacy:{provider:'ds',modelCode:'deepseek-flash'}}},'legacy').modelCode,'deepseek-flash'); assert.throws(()=>r({providers:{ds:p}},'ds/missing')); assert.throws(()=>r({},'missing')); const a=b({maxModelCalls:16,maxTurns:32}); assert.equal(a[a.indexOf('--max-model-calls')+1],'16'); assert.equal(a[a.indexOf('--max-turns')+1],'32'); for(const n of [0,-1,NaN,1.2]) assert.throws(()=>b({maxModelCalls:n,maxTurns:32})); console.log('all behavior probes passed');`)
    const runner = await text('scripts/eval/run.mjs')
    check('接入真实 runner', /config-budget\.mjs/.test(runner) && /buildEvaluationArgs\(/.test(runner) && /resolveEvaluationModel\(/.test(runner))
    check('修复文档旧的非硬预算声明', changed.includes('evals/README.md') && /max-model-calls/.test(await text('evals/README.md')))
    try {
      const probes = await probeRunnerIntegration(workspace, join(caseDir, 'runner-probe-' + Date.now()))
      for (const probe of probes) check('实际入口集成: ' + probe.name, probe.passed, probe.detail)
    } catch (error) { check('实际入口集成: 探针准备', false, `${error.code ?? error.name}: ${error.message}`) }
  }
  if (task.id === 'LT02') {
    await behavior('恢复去重、失败保留、未完成 trial 继续', `import assert from 'node:assert/strict'; const {selectPendingTrials:s}=await import('./scripts/eval/resume.mjs'); const tasks=[{id:'A'},{id:'B'}]; const rows=[{taskId:'A',trial:1,status:'passed'},{taskId:'A',trial:1,status:'passed'},{taskId:'A',trial:2,status:'failed'},{taskId:'B',trial:1,status:'running'}]; assert.deepEqual(s(tasks,2,rows),[{taskId:'B',trial:1},{taskId:'B',trial:2}]); assert.deepEqual(s(tasks,1,[{taskId:'A',trial:1,status:'blocked_env'}]),[{taskId:'B',trial:1}]); assert.deepEqual(s(tasks,1,[]),[{taskId:'A',trial:1},{taskId:'B',trial:1}]); console.log('all resume probes passed');`)
    const runner = await text('scripts/eval/run.mjs')
    check('恢复接入 runner', /resume\.mjs/.test(runner) && /selectPendingTrials\(/.test(runner) && /--resume/.test(runner))
    check('模拟中断测试产物', changed.some(path => /test/.test(path) && /resume/.test(path)))
    try {
      for (const assertion of await probeResumeIntegration(workspace, join(caseDir, `resume-independent-${Date.now()}`))) check(`独立恢复验收: ${assertion.id}`, assertion.passed, assertion.detail ?? '')
    } catch (error) { check('独立恢复验收: 环境', false, `${error.code ?? error.name}: ${error.message}`) }
    const support = load(join(output, 'frozen.json')).support?.[task.id]
    if (support) check('编译依赖未被候选改写', JSON.stringify(await evaluationSupportManifest(workspace)) === JSON.stringify(support))

  }
  if (task.id === 'LT03') {
    await behavior('执行数据核算脚本', `import {execFileSync} from 'node:child_process'; execFileSync(process.execPath,['scripts/eval/audit-runs.mjs','--input','fixtures/run-records.json','--out','grader-audit'],{stdio:'inherit'});`)
    const rows = load(join(workspace, 'fixtures/run-records.json')), unique = [...new Map(rows.map(row => [row.runId, row])).values()]
    let summary
    try { summary = JSON.parse(await text('grader-audit/summary.json')) } catch {}
    check('独立重算去重数', summary?.uniqueRuns === unique.length && summary?.duplicateRecords === rows.length - unique.length)
    for (const field of ['modelCalls', 'inputTokens', 'outputTokens']) {
      const expected = unique.reduce((sum, row) => sum + (row.usage?.[field] ?? 0), 0)
      check(`独立重算 ${field}`, (summary?.[field] ?? summary?.knownTotals?.[field]) === expected)
    }
    check('未知价格保留', summary?.unknownCostRuns === unique.filter(row => !row.usage?.providerCosts?.length).length)
    check('业务未知与运行成功区分', summary?.businessStatusCounts?.unknown === unique.length)
    await behavior('拒绝冲突记录', `import {readFileSync,writeFileSync,existsSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; import assert from 'node:assert/strict'; const baseline=spawnSync(process.execPath,['scripts/eval/audit-runs.mjs','--input','fixtures/run-records.json','--out','conflict-baseline'],{encoding:'utf8'}); assert.equal(baseline.status,0,baseline.stderr); const a=JSON.parse(readFileSync('fixtures/run-records.json')); a.push({...a[0],status:'conflicting-status'}); writeFileSync('conflict-input.json',JSON.stringify(a)); const rejected=spawnSync(process.execPath,['scripts/eval/audit-runs.mjs','--input','conflict-input.json','--out','conflict-output'],{encoding:'utf8'}); assert.notEqual(rejected.status,0); assert.match(rejected.stderr+rejected.stdout,/conflict|冲突/i); assert.equal(existsSync('conflict-output/summary.json'),false);`)
  }
  if (task.id === 'LT04') {
    const report = await text(task.deliverables[0])
    check('官方来源引用', report.includes('https://api-docs.deepseek.com/guides/thinking_mode') && report.includes('https://api-docs.deepseek.com/api/create-chat-completion'))
    check('源码证据', ['openai-compat', 'model-budget', 'normalize'].every(word => report.includes(word)))
    check('适配主题覆盖', ['reasoning_content', 'max_tokens', 'medium'].every(word => report.includes(word)) && /缓存|cache/i.test(report))
    check('风险与可执行回归', /P[012]/.test(report) && /回归|test/i.test(report) && /推断|待验证|未验证/.test(report))
    check('只写调查文档', changed.every(path => path.startsWith('docs/')))
  }
  if (task.id === 'LT05') {
    const controller = await text('docs/task-controller.md'), zh = await text('docs/cli-config.md'), en = await text('docs/cli-config.en.md')
    const program = await text('packages/server/src/task-controller/program.ts'), state = await text('packages/server/src/task-controller/state.ts')
    const version = /const programVersion = options.version \?\? ['"](\d+)['"]/.exec(program)?.[1]
    const attempts = /maxStageAttempts\s*=\s*(\d+)/.exec(state)?.[1]
    check('当前 controller 版本和尝试次数', !!version && !!attempts && new RegExp(`(?:版本|version|v|\u0060)[^\\n]{0,20}${version}(?!\\d)`, 'i').test(controller) && new RegExp(`(?:maxStageAttempts|attempts|尝试)[^\\n]{0,50}${attempts}`, 'i').test(controller))
    check('移除过时尝试承诺', !/at most one additional attempt|最多(?:一|1)次(?:额外|追加)尝试/i.test(controller))
    const maintenance = await text('docs/reviews/documentation-maintenance.md')
    check('不建议删除或清空预算', !maintenance.split('\n').some(line => /清理预算文件|删除预算|清空预算|(?:delete|clear|remove|reset)[^\n]{0,40}(?:budget|ledger)/i.test(line) && !/不要|禁止|不能|不得|never|do not|must not/i.test(line)))
    check('区分会话恢复与文本续做', !/只有[^\n]{0,30}(?:继续\/resume|包含[^\n]{0,12}继续)[^\n]{0,30}触发恢复/.test(zh))
    check('中英全任务预算及排障', [zh, en].every(report => ['maxModelCalls', 'maxTurns', 'ENOTFOUND', 'resume'].every(word => report.includes(word))))
    check('实际文档已修改', ['docs/task-controller.md', 'docs/cli-config.md', 'docs/cli-config.en.md'].every(path => changed.includes(path)))
    check('只改文档', changed.every(path => path.startsWith('docs/')))
  }
  if (task.id === 'LT06') {
    const interactions = await textOutside(join(caseDir, 'interactions.jsonl')), events = await textOutside(join(caseDir, 'events.jsonl'))
    const original = await text('docs/plans/pulse-long-task-evaluation.md'), plan = await text(task.deliverables[0])
    check('同名原件完整保留', original === '# Existing approved user plan\nPreserve this file; never overwrite.\n')
    check('同名询问与访谈', /interview/.test(interactions) && /存在|同名|覆盖/.test(interactions))
    check('真实计划预览', plan.length > 100 && events.includes(JSON.stringify(plan).slice(1, -1)))
    let restored; try { restored = load(join(caseDir, 'restore.json')) } catch {}
    check('冷恢复同 run 同问题且不额外调用', restored?.sameRun && restored?.samePending && restored?.callsBefore === restored?.callsAfterRestore)
    check('明确暂不执行', interactions.includes('final-answer-after-cold-restore') && interactions.includes('暂不执行'))
    check('未实施代码', changed.every(path => path.startsWith('docs/plans/')))
  }
  const responses = (await textOutside(join(caseDir, 'attempts.jsonl'))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'response')
  const toolNames = responses.flatMap(row => row.toolCalls.map(tool => tool.function?.name).filter(Boolean))
  const passedCount = checks.filter(item => item.passed).length
  // Automated checks provide a provisional score. Semantic/manual acceptance is mandatory.
  const limit = load(join(output, 'frozen.json')).dataset.limits.perSampleCalls
  const budgetStatus = limit === null ? 'not_applicable' : result.outerAttempts <= limit ? 'passed' : 'failed'
  const score = Math.round(70 * passedCount / Math.max(1, checks.length)) + (result.outcome?.status === 'succeeded' ? 10 : 0) + (budgetStatus === 'failed' ? 0 : 10) + (changed.length > 0 ? 5 : 0) + (task.id !== 'LT04' || changed.every(path => path.startsWith('docs/')) ? 5 : 0)
  return { taskId: task.id, checks, budgetStatus, provisionalScore: score, requiresManualAcceptance: true, provisionalStatus: passedCount === checks.length ? 'partial' : passedCount > 0 ? 'partial' : 'failed', runtimeStatus: result.outcome?.status ?? 'unknown', businessStatus: result.taskOutcome?.status ?? 'unknown', outerAttempts: result.outerAttempts, changed, toolCalls: toolNames.length, toolNames, result }
}
async function textOutside(path) { try { return await readFile(path, 'utf8') } catch { return '' } }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2]), frozen = load(join(output, 'frozen.json'))
  const grades = []
  for (const task of frozen.dataset.tasks) {
    if (!(await readdir(join(output, task.id))).includes('result.json')) continue
    const grade = await gradeCase(output, task); save(join(output, task.id, 'grade.json'), grade); grades.push(grade)
    console.log(`${task.id}: ${grade.checks.filter(c => c.passed).length}/${grade.checks.length} automated checks; semantic review required`)
  }
  save(join(output, 'grades.json'), grades)
}

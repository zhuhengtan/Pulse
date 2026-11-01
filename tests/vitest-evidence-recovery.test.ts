import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCheck, captureCheck } from '../packages/server/src/check-receipt.js'
import { namedVitestCheck } from '../packages/server/src/vitest-check.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { acceptanceCriteriaFromObjective } from '../packages/server/src/task.js'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'

afterEach(() => vi.unstubAllGlobals())
const runner = 'node_modules/.pnpm/vitest@fixture/node_modules/vitest/vitest.mjs'
it('recognizes the installed Node runner without treating inspected files or inline code as checks', () => {
  expect(isCheck('node', [runner, 'run', '--root', 'packages/web', 'tests/pinned.test.tsx'])).toBe(true)
  expect(isCheck('cat', [runner])).toBe(false)
  expect(isCheck('node', ['worker.mjs', runner, 'run'])).toBe(false)
  expect(isCheck('node', ['--eval', 'console.log(1)', runner])).toBe(false)
})

it('matches only the same explicit Vitest files, root and configuration across launchers', () => {
  const original = namedVitestCheck('pnpm', ['vitest', 'run', 'tests/pinned.test.tsx'], 'packages/web')!.key
  expect(namedVitestCheck('./node_modules/.bin/vitest', ['run', 'tests/pinned.test.tsx'], 'packages/web')?.key).toBe(original)
  expect(namedVitestCheck('node', [runner, 'run', '--root', 'packages/web', 'tests/pinned.test.tsx'])?.key).toBe(original)
  expect(namedVitestCheck('node.exe', [runner.replaceAll('/', '\\'), 'run', 'tests\\pinned.test.tsx'], 'packages\\web')?.key).toBe(original)
  for (const args of [
    [runner, 'run', '--root', 'packages/web', 'tests/other.test.tsx'],
    [runner, 'run', '--root', 'packages/other', 'tests/pinned.test.tsx'],
    [runner, 'run', '--root', 'packages/web', '--config', 'other.config.ts', 'tests/pinned.test.tsx'],
    [runner, 'run', '--root', 'packages/web', '-t', 'one case', 'tests/pinned.test.tsx'],
    [runner, 'run', '--root', 'packages/web', '--passWithNoTests', 'tests/pinned.test.tsx'],
    [runner, 'run', '--root', '/packages/web', 'tests/pinned.test.tsx'],
    [runner, 'run', '--root', 'packages/web'],
  ]) expect(namedVitestCheck('node', args)?.key).not.toBe(original)
})

it.each([false, true])('accepts an actual same-suite rerun after a missing launcher and test edit, but still rejects external changes (%s)', async external => {
  const cwd = await mkdtemp(join(tmpdir(), 'pulse-vitest-recovery-'))
  const target = 'packages/web/tests/pinned.test.mjs'
  const original = "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('original', () => assert.equal(1,1))\n"
  await mkdir(join(cwd, 'packages/web/tests'), { recursive: true })
  await mkdir(join(cwd, 'node_modules/.pnpm/vitest@fixture/node_modules/vitest'), { recursive: true })
  await writeFile(join(cwd, target), original)
  await writeFile(join(cwd, 'packages/web/vitest.config.ts'), 'export default {}\n')
  // A scripted installed-runner fixture executes real node:test assertions.
  await writeFile(join(cwd, runner), "import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';const args=process.argv.slice(2);const root=args.includes('--root')?args[args.indexOf('--root')+1]:'.';const r=spawnSync(process.execPath,['--test',resolve(root,args.at(-1))],{stdio:'inherit'});process.exit(r.status??1)\n")
  const receipt = await captureCheck(cwd, cwd, 'node', [runner, 'run', '--root', 'packages/web', 'tests/pinned.test.mjs'], false, 4)
  expect(receipt.files[target]).toBeTruthy()
  expect(receipt.files['packages/web/vitest.config.ts']).toBeTruthy()
  const objective = '修复会话置顶功能，补充 packages/web/tests/pinned.test.mjs 回归并运行全部新增断言。'
  const ids = acceptanceCriteriaFromObjective(objective).map(c => c.id)
  let turn = 0, stageReviews = 0, finalReviews = 0
  const chat = (message: any) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
  const tool = (name: string, input: object) => chat({content:'',tool_calls:[{id:`call-${turn}`,function:{name,arguments:JSON.stringify(input)}}]})
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request=JSON.parse(String(init.body)), text=currentRequestText(request.messages), results=suppliedRequestResults(request.messages)
    if (text.includes('You are the Pulse safety reviewer')) return chat('APPROVE')
    if (text.includes('Create an executable plan')) return chat(JSON.stringify({tasks:[{id:'fix',kind:'edit',goal:'Extend regression test',check:'Explicit test suite passes with the new regression',dependsOn:[],criterionIds:ids}]}))
    const refs=results.filter((r:any)=>typeof r.value?.code!=='number'||r.value.code===0).map((r:any)=>r.id)
    if (text.includes('Verify ONLY the active taskController stage')) {stageReviews++;return chat(JSON.stringify({status:'passed',evidenceRefs:refs,note:'Current regression executed'}))}
    if (text.includes('Independently verify every ORIGINAL')) {
      finalReviews++
      if (external) await writeFile(join(cwd,target),original+'// external mutation\n')
      return chat(JSON.stringify({criteria:ids.map(id=>({criterionId:id,status:'passed',evidenceRefs:refs,rationale:'Current suite passed'}))}))
    }
    if (text.includes("You write Pulse's final user-facing reply")) return chat('Regression verified.')
    turn++
    if(turn===1)return tool('shell_exec',{command:'node',args:['./node_modules/vitest/vitest.mjs','run','tests/pinned.test.mjs'],cwd:'packages/web'})
    if(turn===2)return tool('fs_apply_patch',{path:target,find:original,replace:original+"\ntest('new regression',()=>assert.equal(2,2))\n",expectedHash:createHash('sha256').update(original).digest('hex')})
    if(turn===3)return tool('shell_exec',{command:'node',args:[runner,'run','--root','packages/web','tests/pinned.test.mjs'],cwd:'.'})
    return chat('Completed edits and current check.')
  }))
  const host=createLocalHost({cwd,dataDir:join(cwd,'data'),jarvis:{enabled:false},approvalMode:'auto',approvalReview:{provider:'ollama',model:'fixture-review',baseURL:'http://127.0.0.1:9',timeoutMs:1000},taskController:true,maxModelCalls:24,provider:{provider:'openai-compatible',defaultModel:'fixture'}})
  try {
    const conversation=await host.createConversation(), run=await host.sendMessage(conversation.id,{text:objective}), outcome=await run.outcome()
    expect(outcome,JSON.stringify(outcome)).toMatchObject({status:'succeeded'})
    expect(await run.taskOutcome(),outcome.text).toMatchObject({status:external?'incomplete':'accepted'})
    const controller=JSON.parse(await readFile(join(cwd,'data/conversations',conversation.id,'runs',run.id,'task-controller.json'),'utf8'))
    expect(stageReviews).toBeGreaterThan(0);expect(finalReviews).toBeGreaterThan(0)
    if(!external){expect(stageReviews).toBe(1);expect(finalReviews).toBe(1);expect(turn).toBeLessThanOrEqual(4);expect(controller.tasks[0].freshnessRecoveries??0).toBe(0)}
  } finally {await host.close();await rm(cwd,{recursive:true,force:true})}
// Two real sandbox launches include cold Windows account/ACL setup and cleanup.
},process.platform === 'win32' ? 480_000 : 30_000)

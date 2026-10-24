import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { captureCheck, finishCheck, freezeCheckDefinitions } from '../packages/server/src/check-receipt.js'
import { staleFileEvidence } from '../packages/server/src/task-controller/evidence-current.js'
import { coversUnavailablePythonCheck } from '../packages/server/src/task-controller/check-coverage.js'
import { reusableEvidence } from '../packages/runtime/src/dsl/evidence-reuse.js'
import { stageRequiresFileChange } from '../packages/server/src/task-controller/state.js'

it('allows executing a named generator without requiring an unrelated extra edit, only in v21', () => {
  const goal='Run converter to generate output/settings.json from input/settings.txt'
  expect(stageRequiresFileChange(goal,'output is correct','edit',true,true,false)).toBe(true)
  expect(stageRequiresFileChange(goal,'output is correct','edit',true,true,true)).toBe(false)
  expect(stageRequiresFileChange('Run converter and fix output/settings.json','correct','edit',true,true,true)).toBe(true)
  expect(stageRequiresFileChange('Create output/settings.json','correct','edit',true,true,true)).toBe(true)
})

it('refreshes a read after a shell command but still reuses unchanged repeated observations', () => {
  const values:any={'result-1':{path:'input.txt',hash:'a'},'result-2':{code:0},'result-3':{path:'input.txt',hash:'a'}}
  const metas:any={'result-1':{toolName:'fs.read',outcomeStatus:'succeeded'},'result-2':{toolName:'shell.exec',outcomeStatus:'succeeded'},'result-3':{toolName:'fs.read',outcomeStatus:'succeeded'}}
  const ctx:any={results:{read:(r:string)=>values[r],meta:(r:string)=>metas[r]}}
  const calls=[{toolName:'fs.read',input:{path:'input.txt'}}]
  expect(reusableEvidence(ctx,calls,['result-1','result-2'],false)?.refs).toEqual(['result-1'])
  expect(reusableEvidence(ctx,calls,['result-1','result-2'],true)).toBeUndefined()
  expect(reusableEvidence(ctx,calls,['result-1','result-2','result-3'],true)?.refs).toEqual(['result-3'])
  metas['result-2'].outcomeStatus='failed' // Failed commands can still mutate files.
  expect(reusableEvidence(ctx,calls,['result-1','result-2'],true)).toBeUndefined()
})

it('tracks Python module input/imports, candidate correction, and real external tampering', async () => {
  const root=await mkdtemp(join(tmpdir(),'pulse-python-v21-')),store=await mkdtemp(join(tmpdir(),'pulse-python-receipts-'))
  try {
    await mkdir(join(root,'tests'));await mkdir(join(root,'src'))
    await writeFile(join(root,'src/util.py'),'VALUE = 1\n')
    await freezeCheckDefinitions(root,store,false,true,3)
    await writeFile(join(root,'tests/test_util.py'),'from src.util import VALUE\nassert VALUE == 2\n')
    const args=['-m','unittest','-v','tests.test_util']
    const old=await finishCheck(root,await captureCheck(root,root,'python3',args,false,3),store)
    expect(old.files).toHaveProperty('tests/test_util.py');expect(old.files).toHaveProperty('src/util.py')
    await writeFile(join(root,'tests/test_util.py'),'from src.util import VALUE\nassert VALUE == 1\n')
    const current=await finishCheck(root,await captureCheck(root,root,'python3',args,false,3),store)
    expect(current.definitionChanged).toBe(false)
    const rt=new PulseRuntime()
    for(const [id,receipt,code] of [['result-1',old,1],['result-2',current,0]] as const)rt.state.results.set(id,{id,privacy:'public',derivedFrom:[],value:{code,checkReceipt:receipt as any}})
    expect(await staleFileEvidence(root,['result-1','result-2'],rt)).toEqual([])
    await writeFile(join(root,'src/util.py'),'VALUE = 9\n')
    expect(await staleFileEvidence(root,['result-1','result-2'],rt)).toEqual(['result-2'])
    await writeFile(join(root,'src/util.py'),'VALUE = 1\n');await writeFile(join(root,'tests/test_util.py'),'assert True\n')
    expect(await staleFileEvidence(root,['result-1','result-2'],rt)).toEqual(['result-2'])
  } finally {await rm(root,{recursive:true,force:true});await rm(store,{recursive:true,force:true})}
})

it('does not let a parent Git ignore rule erase the workspace check inventory', async () => {
  const parent=await mkdtemp(join(tmpdir(),'pulse-parent-inventory-')),root=join(parent,'ignored')
  try {execFileSync('git',['init','-q'],{cwd:parent});await writeFile(join(parent,'.gitignore'),'ignored/\n');await mkdir(root);await writeFile(join(root,'test.py'),'assert True\n')
    const receipt=await captureCheck(root,root,'python3',['-m','unittest','discover'],false,3)
    expect(receipt.files).toHaveProperty('test.py')
  } finally {await rm(parent,{recursive:true,force:true})}
})

it('permits a covered optional-runner fallback, rejecting explicit runner contracts and partial checks', () => {
  const a:any={command:'python3',args:['-m','pytest','tests/test_util.py','-v']},b:any={command:'python3',args:['-m','unittest','-v','tests.test_util']}
  const receipt:any={schemaVersion:3,files:{'tests/test_util.py':'hash'},stable:true,definitionChanged:false}
  const old:any={code:1,stderr:'python3: No module named pytest\n',checkReceipt:receipt}
  const fresh:any={code:0,stderr:'Ran 6 tests in 0.001s\n\nOK\n',checkReceipt:receipt}
  expect(coversUnavailablePythonCheck(a,old,b,fresh,'Implement with stdlib')).toBe(true)
  expect(coversUnavailablePythonCheck(a,old,b,fresh,'Run pytest')).toBe(false)
  expect(coversUnavailablePythonCheck(a,{...old,stderr:'Assertion failed'},b,fresh,'')).toBe(false)
  expect(coversUnavailablePythonCheck(a,old,b,{...fresh,stderr:'Ran 0 tests in 0s\nOK\n'},'')).toBe(false)
  expect(coversUnavailablePythonCheck(a,old,{...b,args:[...b.args,'-k','one']},fresh,'')).toBe(false)
  expect(coversUnavailablePythonCheck(a,old,b,{...fresh,checkReceipt:{...receipt,files:{}}},'')).toBe(false)
  expect(coversUnavailablePythonCheck(a,old,b,{...fresh,checkReceipt:{...receipt,definitionChanged:true}},'')).toBe(false)
})

import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript'
import { runShell } from '../packages/adapters/src/tools/shell.js'
import { restrictLoopbackSandbox } from '../packages/adapters/src/tools/loopback-sandbox.js'
import { dataEndpoint } from '../packages/data/src/index.js'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
it('narrows macOS bind/inbound grants and fails closed for an unknown profile',()=>{
  const profile='(allow network-bind (local ip "*:*"))\n(allow network-inbound (local ip "*:*"))\n(allow network-outbound (remote ip "localhost:*"))'
  const result=restrictLoopbackSandbox(['/usr/bin/sandbox-exec','-p',profile,'/bin/sh'],'darwin')
  expect(result[2]).not.toContain('"*:*"')
  expect(result[2]).toContain('remote ip "localhost:*"')
  expect(()=>restrictLoopbackSandbox(['/bin/sh','-p',profile],'darwin')).toThrow('UNRECOGNIZED')
  expect(restrictLoopbackSandbox(['bwrap','--unshare-net'],'linux')).toEqual(['bwrap','--unshare-net'])
  expect(restrictLoopbackSandbox(['srt.exe','--'],'win32')).toEqual(['srt.exe','--'])
})
it('retains the ordinary endpoint and rejects unsafe Unix socket path lengths',()=>{
  const previous=process.env.PULSE_DATA_IPC_ROOT
  try{
    delete process.env.PULSE_DATA_IPC_ROOT
    if(process.platform!=='win32')expect(dataEndpoint('/example')).toContain('/tmp/pulse-ipc-')
    process.env.PULSE_DATA_IPC_ROOT='/tmp/'+ 'x'.repeat(100)
    if(process.platform!=='win32')expect(()=>dataEndpoint('/example')).toThrow('PATH_TOO_LONG')
  }finally{if(previous===undefined)delete process.env.PULSE_DATA_IPC_ROOT;else process.env.PULSE_DATA_IPC_ROOT=previous}
})
it.skipIf(process.platform!=='darwin')('runs package-local source reads, private IPC and loopback HTTP in the real macOS sandbox while denying sibling reads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pulse-v58-native-'));roots.push(root)
  const workspace=join(root,'workspace'),cwd=join(workspace,'packages','app');await mkdir(cwd,{recursive:true});await mkdir(join(workspace,'data-code'))
  await writeFile(join(workspace,'root.json'),'ROOT_CONFIG')
  await writeFile(join(workspace,'package.json'),JSON.stringify({version:'0.0.0-fixture',type:'module'}))
  await writeFile(join(root,'private.json'),'SIBLING_SECRET')
  const src=await readFile('packages/data/src/index.ts','utf8')
  await writeFile(join(workspace,'data-code/index.mjs'),transpileModule(src,{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ESNext}}).outputText)
  for(const name of await readdir('packages/data/src'))if(name.endsWith('.mjs'))await copyFile(join('packages/data/src',name),join(workspace,'data-code',name))
  await writeFile(join(cwd,'probe.mjs'),`import fs from 'node:fs';import http from 'node:http';import{ConversationData}from'../../data-code/index.mjs';
    const c=new ConversationData(new URL('../../test-data',import.meta.url).pathname);const revision=await c.call('revision');await c.close();
    const server=http.createServer((req,res)=>res.end('LOOPBACK_OK'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const text=await fetch('http://127.0.0.1:'+server.address().port).then(r=>r.text());await new Promise(r=>server.close(r));
    let denied=false;try{fs.readFileSync('../../../private.json')}catch{denied=true}
    console.log(JSON.stringify({revision,text,denied,root:fs.readFileSync('../../root.json','utf8'),ipc:process.env.PULSE_DATA_IPC_ROOT,mode:fs.statSync(process.env.PULSE_DATA_IPC_ROOT).mode&511}));await new Promise(r=>setTimeout(r,1700));`)
  const result=await runShell(process.execPath,['probe.mjs'],{cwd,workspaceRoot:workspace,allowLoopback:true,timeoutMs:25000})
  expect(result.code,result.stderr+'\n'+result.stdout).toBe(0)
  const value=JSON.parse(result.stdout.trim())
  expect(value).toMatchObject({revision:0,text:'LOOPBACK_OK',denied:true,root:'ROOT_CONFIG',mode:0o700})
  expect(value.ipc).not.toMatch(/pulse-ipc-\d+$/)
  await expect(stat(value.ipc)).rejects.toThrow()
},35000)
it.skipIf(process.platform!=='darwin')('starts an isolated Pulse H5 API inside the real sandbox',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pulse-v58-h5-probe-'));roots.push(root)
  const result=await runShell(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/live/h5-sandbox-probe.test.ts'],{cwd:resolve('.'),workspaceRoot:resolve('.'),allowLoopback:true,env:{...process.env,PULSE_SANDBOX_H5_PROBE:'1',PULSE_HOME:root,PULSE_CONFIG:''},timeoutMs:45000,maxOutputBytes:10000})
  expect(result.code,result.stderr+'\n'+result.stdout).toBe(0)
  expect(result.stdout).toContain('1 passed')
},55000)

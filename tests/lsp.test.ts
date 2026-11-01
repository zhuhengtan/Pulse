import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LspService, registerLspTools, lspTemplates } from '../packages/server/src/lsp/index.js'
import { LspFrames, lspFrame } from '../packages/server/src/lsp/protocol.js'
import { createLocalHost } from '../packages/server/src/index.js'
import { runShell } from '@hunterzhu/pulse-adapters'
import { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
const roots:string[]=[], controllers:AbortController[]=[]
afterEach(async()=>{controllers.splice(0).forEach(c=>c.abort());await new Promise(r=>setTimeout(r,150));await Promise.all(roots.splice(0).map(root=>rm(root,{force:true,recursive:true})))})
async function fixture(mode=''){
 const root=await mkdtemp(join(tmpdir(),'pulse-lsp-'));roots.push(root);const controller=new AbortController();controllers.push(controller)
 await copyFile(resolve('tests/fixtures/lsp/server.cjs'),join(root,'server.cjs'));await writeFile(join(root,'a.ts'),'const a=1\n')
 const config={enabled:true,servers:{test:{command:process.execPath,args:[join(root,'server.cjs'),mode],languages:{'.ts':'typescript'}}}}
 return {root,controller,config,service:new LspService(root,config,controller.signal)}
}
it('frames split UTF8 bytes and rejects oversized, malformed and duplicate lengths',()=>{
 const values:any[]=[],parser=new LspFrames(v=>values.push(v)),bytes=lspFrame({jsonrpc:'2.0',id:1,result:'你好'})
 for(const b of bytes)parser.push(Buffer.from([b]));expect(values[0].result).toBe('你好')
 for(const header of ['Content-Length: 99999999','Content-Length: 2\r\nContent-Length: 2','X: 2'])expect(()=>new LspFrames(()=>{}).push(Buffer.from(header+'\r\n\r\n{}'))).toThrow()
 expect(()=>new LspFrames(()=>{}).push(Buffer.from('X: '+'a'.repeat(20000)+'\r\nContent-Length: 17\r\n\r\n{"jsonrpc":"2.0"}'))).toThrow('LSP_HEADER_TOO_LARGE')
})
it('uses real sandboxed stdio, filters escapes, versions changes, reuses process and does not hold shell lease',async()=>{
 const f=await fixture();const q=(k:'symbols'|'diagnostics'|'definition')=>f.service.query(k,{path:'a.ts',line:1,column:1},f.controller.signal)
 const first=await q('symbols');expect(JSON.stringify(first)).toContain('write=denied');expect(first.freshness).toBe('current')
 expect((await q('definition')).items).toHaveLength(1)
 expect(JSON.stringify(await q('diagnostics'))).toContain('v1');await writeFile(join(f.root,'a.ts'),'const a=2\n');expect(JSON.stringify(await q('diagnostics'))).toContain('v2')
 expect((await q('symbols')).items).toEqual(first.items)
 const shell=await runShell(process.execPath,['-e','console.log("parallel")'],{cwd:f.root,timeoutMs:10000});expect(shell.stdout).toContain('parallel')
 await expect(readFile(join(f.root,'unauthorized.txt'))).rejects.toThrow()
},process.platform === 'win32' ? 480000 : 45000)
it('reports unavailable without installation, and rejects workspace escape',async()=>{
 const f=await fixture();await expect(new LspService(f.root,undefined,f.controller.signal).query('symbols',{path:'a.ts'},f.controller.signal)).rejects.toThrow('CODE_SERVER_UNAVAILABLE')
 await expect(f.service.query('symbols',{path:'/etc/passwd'},f.controller.signal)).rejects.toThrow('CODE_PATH_OUTSIDE_WORKSPACE')
 const missing=new LspService(f.root,{enabled:true,servers:{bad:{command:'pulse-no-such-lsp',languages:{'.ts':'typescript'}}}},f.controller.signal)
 await expect(missing.query('symbols',{path:'a.ts'},f.controller.signal)).rejects.toThrow('CODE_SERVER_UNAVAILABLE');expect(Object.keys(lspTemplates)).toEqual(['typescript','python','go','rust'])
})
it.each(['crash','oversize'])('cleans and rebuilds %s processes',async(mode)=>{
 const f=await fixture(mode);for(let n=0;n<2;n++)await expect(f.service.query('symbols',{path:'a.ts'},f.controller.signal)).rejects.toThrow('LSP_SERVER_UNAVAILABLE')
},process.platform === 'win32' ? 480000 : 45000)
it('cancels outstanding RPC without launching another operation',async()=>{
 const f=await fixture('hang'),signal=new AbortController();const pending=f.service.query('symbols',{path:'a.ts'},signal.signal);setTimeout(()=>signal.abort(),1500);await expect(pending).rejects.toThrow(/CANCELLED|UNAVAILABLE/)
},process.platform === 'win32' ? 480000 : 45000)
it('registers strict read-only tools in actual Host new assistant runs',async()=>{
 const f=await fixture();const registry=new ToolRegistry();registerLspTools(registry,f.service);expect(registry.list().every(t=>t.sideEffectPolicy==='read')).toBe(true)
 const host=createLocalHost({cwd:f.root,dataDir:join(f.root,'data'),lsp:f.config,taskController:false,approvalMode:'auto',provider:{provider:'mock',defaultModel:'mock'},providerProfiles:{mock:{provider:'mock',defaultModel:'mock'}},providerModels:{mock:{provider:'mock',model:'mock'}},activeModel:'mock',assistantModel:'mock',mockToolCalls:[{name:'code.symbols',input:{path:'a.ts'}}],mockAfterToolResponse:'done'});await host.init()
 try{const conversation=await host.createConversation({cwd:f.root});const run=await host.sendMessage(conversation.id,{text:'使用 code.symbols 查看 a.ts',assistantChat:true});expect((await run.outcome()).status).toBe('succeeded')
 const input=JSON.parse(await readFile(join(f.root,'data/conversations',conversation.id,'runs',run.id,'input.json'),'utf8'));expect(input.codeSurfaceVersion).toBe(1);expect(input.lsp?.enabled).toBe(true);expect(input.lsp?.servers?.test?.command).toBe(process.execPath);expect(input.lsp?.root).toBeUndefined();expect(input.lsp?.servers?.test?.root).toBeUndefined()
 const saved=await readFile(join(f.root,'data/conversations',conversation.id,'runs',run.id,'runtime.json'),'utf8');expect(saved).toContain('write=denied')
 }finally{await host.close()}
},process.platform === 'win32' ? 480000 : 45000)

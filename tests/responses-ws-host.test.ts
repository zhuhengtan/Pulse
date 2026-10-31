import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve,join } from 'node:path';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { it,expect } from 'vitest';
import { createLocalHost } from '@hunterzhu/pulse-server';
import { hostOptions,parse } from '../packages/cli/src/bin.js';
import { captureProviderApiModes,restoreProviderApiModes } from '../packages/server/src/run-provider-modes.js';
import { createProviderAdapter } from '@hunterzhu/pulse-adapters';
const {WebSocketServer}=createRequire(resolve('packages/server/package.json'))('ws');
it.each(['same','changed-setting'])('retains transport/private visibility through CLI→disk→cold Host resume (%s)',async variant=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0}),sockets:any[]=[],requests:any[]=[];
 await once(server,'listening');
 server.on('connection',(socket:any)=>{sockets.push(socket);socket.on('message',(bytes:Buffer)=>{
  const body=JSON.parse(bytes.toString());requests.push(body);
  const assessment=body.text?.format?.schema?.properties?.status;
  const reply=assessment?JSON.stringify({status:'unverifiable',criteria:[{criterionId:'criterion-1',status:'unverifiable',rationale:'Local fixture only.',evidenceRefs:[]}],note:'No business acceptance in protocol fixture.'}):'Local fixture finished.';
  const output=requests.length===1?[{type:'reasoning',id:'rs-local',encrypted_content:'fixture-private-ws',summary:[]},{type:'function_call',id:'fc-local',status:'completed',call_id:'native-call',name:'fs_write',arguments:'{"path":"once.txt","content":"once"}'}]:[{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:reply}]}];
  const response={id:'r'+requests.length,status:'completed',output,usage:{input_tokens:11,output_tokens:5}};
  socket.send(JSON.stringify({type:'response.created',response:{id:response.id}}));socket.send(JSON.stringify({type:'response.completed',response}));
 })});
 const root=await mkdtemp(join(tmpdir(),'pulse-ws-cold-')),configPath=join(root,'fixture.json'),dataDir=join(root,'data');
 const config={cwd:root,dataDir,jarvis:{enabled:false},taskController:false,approvalMode:'ask',capabilities:{enabled:[]},activeModel:'fixture/model',providers:{fixture:{provider:'openai-compatible',apiMode:'responses',responsesTransport:'websocket',baseURL:`http://127.0.0.1:${server.address().port}/v1`,maxContextTokens:65536,models:{model:{modelCode:'local-model'}}}}};
 let first:ReturnType<typeof createLocalHost>|undefined,second:typeof first;
 try{
  await writeFile(configPath,JSON.stringify(config));const options=await hostOptions(parse(['--config',configPath,'--no-task-controller']));
  expect(options.provider?.responsesTransport).toBe('websocket');first=createLocalHost(options);
  const seen:unknown[]=[];const c=await first.createConversation(),run=await first.sendMessage(c.id,{text:'Create once.txt with once using the local fixture.'});
  for await(const event of run.events){seen.push(event);if(event.type==='waiting')break;}
  const runDir=join(options.dataDir!,'conversations',c.id,'runs',run.id),saved=JSON.parse(await readFile(join(runDir,'input.json'),'utf8'));
  expect(saved.providerApiModes.transports).toEqual({fixture:'websocket'});expect(requests).toHaveLength(1);
  const before=JSON.parse(await readFile(join(runDir,'model-budget.json'),'utf8'));
  const runtime=(first as any).active.get(run.id).runtime;runtime.cancelAgent=()=>{};await first.close();
  if(variant==='changed-setting')config.providers.fixture.responsesTransport='http';await writeFile(configPath,JSON.stringify(config));
  second=createLocalHost(await hostOptions(parse(['--config',configPath,'--no-task-controller'])));const resumed=await second.resumeRun(c.id);
  for await(const event of resumed.events){seen.push(event);if(event.type==='waiting')await resumed.reply((event.data as any).effectId,{approved:true});}
  expect((await resumed.outcome()).status).toBe('succeeded');expect(await readFile(join(root,'once.txt'),'utf8')).toBe('once');
  expect(requests.length).toBeGreaterThan(1);expect(requests[1].previous_response_id).toBeNull();expect(requests[1].input.some((x:any)=>x.type==='function_call_output')).toBe(true);
  const after=JSON.parse(await readFile(join(runDir,'model-budget.json'),'utf8'));expect(after.used).toBeGreaterThan(before.used);
  expect(JSON.stringify(seen)).not.toContain('fixture-private-ws');expect(JSON.stringify(await second.getConversation(c.id))).not.toContain('fixture-private-ws');expect(JSON.stringify(requests[1]).includes('fixture-private-ws')).toBe(variant==='same');
  // The disk snapshot remains the persisted execution authority; no second request repeats native-call.
  expect(requests.slice(1).every(r=>r.previous_response_id===null)).toBe(true);
 }finally{await second?.close();await first?.close();for(const s of sockets)s.terminate();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}
},30000);
it('old snapshots cannot inherit a newly selected websocket transport',()=>{
 const provider={provider:'openai',apiMode:'responses' as const,responsesTransport:'websocket' as const};
 const saved=captureProviderApiModes({provider});expect(saved).toMatchObject({transports:{openai:'websocket'}});
 expect(restoreProviderApiModes({provider},{schemaVersion:1,modes:{openai:'responses'}}).provider?.responsesTransport).toBe('http');
 expect(restoreProviderApiModes({provider},undefined).provider?.apiMode).toBe('chat-completions');
 expect(()=>createProviderAdapter({...provider,responsesTransport:'invalid' as any})).toThrow('PROVIDER_RESPONSES_TRANSPORT_INVALID');
 expect(()=>createProviderAdapter({...provider,apiMode:'chat-completions'})).toThrow('PROVIDER_RESPONSES_TRANSPORT_UNSUPPORTED');
});

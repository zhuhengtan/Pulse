import { expect, it } from 'vitest';
import { createModelEffectExecutor, type ProviderAdapter } from '@hunterzhu/pulse-adapters';
import { InMemoryModelRegistry, ModelRouter, type EffectRecord, type LLMRequestProjection } from '@hunterzhu/pulse-runtime';
const request:LLMRequestProjection={contextSpec:{globalSnapshotVersion:0,laneSnapshotVersion:0,resultRefs:[],eventIds:[],toolSetId:'x',instruction:'x',privacy:'public',privacyRefs:[]},blocks:[{kind:'instruction',content:'x'}],prefixHash:'p',projectionHash:'p',builderVersion:'1',policyVersion:'1',toolSetVersion:'1',privacy:'public',privacyRefs:[]};
it('forks connection ownership without forking budget callbacks or raw agent/lane IDs',async()=>{
 const registry=new InMemoryModelRegistry();registry.register({id:'m',providerId:'p',priority:1,tasks:['reason'],capabilities:{local:true,toolCalling:true,structuredOutput:true,reasoning:'low',maxContextTokens:32000,maxOutputTokens:1000}});
 const keys:string[]=[],released:string[]=[];let reserves=0;
 const provider:ProviderAdapter={id:'p',name:'fixture',executeAttempt:async p=>{keys.push(p.connectionKey!);return {text:'ok',toolCalls:[],finishReason:'stop'}},releaseConnectionScope:s=>released.push(s)};
 const execute=createModelEffectExecutor({router:new ModelRouter(registry),providers:new Map([['p',provider]]),beforeProviderAttempt:async()=>{reserves++}}),fork=execute.forkConnectionScope();
 const effect={id:'same-e',kind:'llm',agentId:'agent-1',ownerLaneId:'lane-1',attemptId:'a1',attemptNo:1,input:{task:'reason',request},retryPolicy:{maxAttempts:1}} as unknown as EffectRecord;
 expect((await execute(effect,new AbortController().signal)).executionState).toBe('succeeded');
 expect((await fork(effect,new AbortController().signal)).executionState).toBe('succeeded');
 expect(keys[0]).not.toEqual(keys[1]);expect(reserves).toBe(2);
 fork.dispose();expect(released).toHaveLength(1);expect(keys[1]!.startsWith(released[0]!+':')).toBe(true);
});

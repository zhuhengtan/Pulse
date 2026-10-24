import { expect, it } from 'vitest'
import { PulseRuntime } from '@hunterzhu/pulse-runtime'
import { automationApprovalEvidence } from '../packages/server/src/automation/approval-evidence.js'
it('binds GUI review context to the requested session, frame and lane', () => {
 const runtime=new PulseRuntime(), effect:any={ownerLaneId:'lane',input:{name:'browser.act',arguments:{sessionId:'session',frameId:'fresh'}}}
 runtime.state.effects.set('observe',{id:'observe',kind:'tool',ownerLaneId:'lane',input:{name:'browser.observe',arguments:{sessionId:'session'}},outcome:{status:'succeeded',resultRef:'frame'}} as any)
 runtime.state.results.set('frame',{value:{frameId:'fresh',title:'Local fixture',url:'http://127.0.0.1',text:'button Apply'}} as any)
 expect(automationApprovalEvidence(runtime,effect)).toMatchObject({observedTarget:{frameId:'fresh',text:'button Apply'}})
 expect(automationApprovalEvidence(runtime,{...effect,ownerLaneId:'other'})).toMatchObject({observedTarget:null})
 expect(automationApprovalEvidence(runtime,{...effect,input:{name:'browser.act',arguments:{sessionId:'other',frameId:'fresh'}}})).toMatchObject({observedTarget:null})
 expect(automationApprovalEvidence(runtime,{...effect,input:{name:'browser.act',arguments:{sessionId:'session',frameId:'stale'}}})).toMatchObject({observedTarget:null})
})

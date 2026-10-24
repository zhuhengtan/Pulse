import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createRuntimeState, createAgent, publishArtifact, ContextBuilder } from '@hunterzhu/pulse-runtime'
import { createModelEffectExecutor } from '@hunterzhu/pulse-adapters'
import { createHostModelRouting } from '../../packages/server/src/model-routing.js'
import { AutomationSessionManager } from '../../packages/server/src/automation/manager.js'
import { createLocalHost } from '../../packages/server/src/index.js'

it.runIf(process.env.PULSE_VISION_LIVE === '1')('accepts the saved-model image protocol probe through a real local provider',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pulse-vision-probe-'))
  const config=await readFile(join(homedir(),'.pulse/config.json'),'utf8').then(JSON.parse)
  const configured=Object.entries(config.providers??{}).find(([,profile]:[string,any])=>profile.provider==='ollama') as [string,any]|undefined
  if(!configured)throw new Error('LIVE_OLLAMA_PROFILE_REQUIRED')
  const [id,profile]=configured,model=process.env.PULSE_VISION_MODEL??Object.values(profile.models??{}).map((model:any)=>model.modelCode)[0]
  const reference=`${id}/${model}`
  const host=createLocalHost({cwd:root,dataDir:root,activeModel:reference,activeProviderCode:id,provider:{provider:'ollama',baseURL:profile.baseURL,defaultModel:model,reasoningEffort:'none'},providerModels:{[reference]:{provider:id,model,imageInput:'supported'}}})
  try {const result=await host.probeVisionModel(reference);expect(result.accepted).toBe(true);expect(result.response.length).toBeGreaterThan(0)}
  finally {await host.close();await rm(root,{recursive:true,force:true})}
},45000)

it.runIf(process.env.PULSE_VISION_LIVE === '1')('routes a real screenshot artifact to a local vision model and applies its chosen click', async()=>{
  const root=await mkdtemp(join(tmpdir(),'pulse-vision-live-'))
  const config=await readFile(join(homedir(),'.pulse/config.json'),'utf8').then(JSON.parse)
  const configured=Object.entries(config.providers??{}).find(([,profile]:[string,any])=>profile.provider==='ollama') as [string,any]|undefined
  if(!configured)throw new Error('LIVE_OLLAMA_PROFILE_REQUIRED')
  const [providerId,profile]=configured
  const model=process.env.PULSE_VISION_MODEL??Object.values(profile.models??{}).map((model:any)=>model.modelCode)[0]
  if(!model)throw new Error('LIVE_OLLAMA_MODEL_REQUIRED')
  let saved=''
  const blueLeft=Math.random()<.5
  const fixture=createServer(async(req,res)=>{
    if(req.url==='/clicked'){for await(const chunk of req)saved+=chunk.toString();res.end('ok');return}
    res.setHeader('content-type','text/html; charset=utf-8')
    res.end(`<title>Vision Acceptance</title><style>body{margin:0;background:white}button{position:absolute;top:240px;width:400px;height:300px;border:0}</style>${[blueLeft?'blue':'red',blueLeft?'red':'blue'].map((color,index)=>`<button aria-label="Target ${index}" style="left:${80+index*720}px;background:${color}" onclick="fetch('/clicked',{method:'POST',body:'${color}'})"></button>`).join('')}`)
  })
  const manager=new AutomationSessionManager(root,{browser:{channel:'chrome'}},true,undefined,['127.0.0.1'])
  await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve))
  try {
    const session=await manager.open('browser','vision-live',root,'dedicated')
    await manager.command(session.id,'navigate',{url:`http://127.0.0.1:${(fixture.address() as {port:number}).port}`},'vision-live')
    const frame=await manager.observe(session.id,'vision-live')
    const image=frame.pulseImage as {mediaType:'image/png';data:string}
    const state=createRuntimeState(),{root:lane}=createAgent(state,'Click the blue rectangle in the screenshot',{programId:'vision-live',programVersion:'1',step:'start',locals:{}})
    const artifact=publishArtifact(state,{mediaType:image.mediaType,content:Buffer.from(image.data,'base64'),laneId:lane.id,privacy:'local_only'})
    state.results.set('shot',{id:'shot',value:{artifactRef:artifact.ref},privacy:'local_only',derivedFrom:[]})
    lane.visibleResultRefs!.add('shot')
    const request=new ContextBuilder(state).build({agent:state.agents.get(lane.agentId)!,lane,resultRefs:['shot'],instruction:'Look only at the attached screenshot. Find the center of the BLUE rectangle. Return JSON {"x":number,"y":number} with coordinates normalized from 0 to 1 relative to the entire image. No explanation.',toolSetId:'vision-live'})
    expect(request.images).toEqual([{ref:artifact.ref,mediaType:'image/png'}])
    expect(JSON.stringify(request)).not.toContain(image.data)
    const reference=`${providerId}/${model}`
    const routing=createHostModelRouting({activeModel:'text/mock',activeProviderCode:'text',activeProvider:{provider:'mock',defaultModel:'mock'},providerProfiles:{[providerId]:{provider:'ollama',baseURL:profile.baseURL,defaultModel:model,maxOutputTokens:512,reasoningEffort:'none'}},providerModels:{'text/mock':{provider:'text',model:'mock'},[reference]:{provider:providerId,model,imageInput:'supported',maxContextTokens:32000,maxOutputTokens:512,reasoningEffort:'low'}},taskRouting:{vision:[reference]}})
    let resolved=0
    const execute=createModelEffectExecutor({...routing,resolveImage:(ref,agentId,privacy)=>{expect(ref).toBe(artifact.ref);expect(agentId).toBe(lane.agentId);expect(privacy).toBe('local_only');resolved++;return state.artifacts.get(ref)!.contentBase64}})
    const schema={type:'object',properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1}},required:['x','y'],additionalProperties:false}
    const result=await execute({id:'vision-effect',kind:'llm',agentId:lane.agentId,ownerLaneId:lane.id,attemptId:'vision-attempt',attemptNo:1,input:{task:'reason',request,outputSchema:schema}} as any,AbortSignal.timeout(90000))
    expect(result.error?.code).toBeUndefined()
    expect(result.executionState).toBe('succeeded')
    expect(resolved).toBe(1)
    expect(result.metadata).toMatchObject({selected:{id:reference,providerId}})
    const point=result.value as {x:number;y:number}
    await manager.act(session.id,String(frame.frameId),{type:'click',point,button:'left',count:1},'model-click','vision-live')
    await expect.poll(()=>saved,{timeout:5000}).toBe('blue')
    expect(JSON.stringify(request)).not.toContain(image.data)
  } finally {await manager.close();await new Promise<void>(resolve=>fixture.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
},120000)

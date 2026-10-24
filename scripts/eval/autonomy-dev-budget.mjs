import {writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'

// Only the retained development service is eligible. Restore only our field,
// using a fresh revision so unrelated edits cannot be overwritten.
export async function withDevCallBudget(out, maxCalls, execute) {
  const base='http://127.0.0.1:7333'
  const expected=resolve('.pulse-dev/autonomy-20261023/prepared-dev-config.json')
  const request=async(method,path,body)=>{
    const session=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
    if(!session.ok)throw Error('DEV_SESSION_UNAVAILABLE')
    const response=await fetch(base+path,{method,headers:{Origin:base,Cookie:session.headers.get('set-cookie'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
    if(!response.ok)throw Error(`DEV_BUDGET_HTTP_${response.status}`)
    return response.json()
  }
  const current=await request('GET','/api/config')
  if(current.path!==expected)throw Error('DEV_CONFIG_PATH_MISMATCH')
  const previous=current.config.maxModelCalls
  const save=async(snapshot,value)=>{
    if(snapshot.path!==expected)throw Error('DEV_CONFIG_PATH_MISMATCH')
    const config={...snapshot.config}
    if(value===undefined)delete config.maxModelCalls;else config.maxModelCalls=value
    const result=await request('PUT','/api/config',{version:snapshot.version,config})
    if(!result.applied||result.restartRequired.length)throw Error('DEV_BUDGET_NOT_APPLIED')
  }
  await save(current,maxCalls)
  await writeFile(join(out,'budget-configuration.json'),JSON.stringify({path:expected,previous:previous??null,limit:maxCalls,changedAt:new Date().toISOString()},null,2))
  try{return await execute()}
  finally{
    const latest=await request('GET','/api/config')
    if(latest.config.maxModelCalls!==maxCalls)throw Error('DEV_BUDGET_CHANGED_EXTERNALLY')
    await save(latest,previous)
    await writeFile(join(out,'budget-configuration-restored.json'),JSON.stringify({restored:previous??null,at:new Date().toISOString()}))
  }
}

import {writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'

// Reproduce the already-frozen missing-capability case in the original service.
// Only narrow enabled capabilities for that case, then restore the same field.
export async function withMissingBrowserCapability(out,execute){
 const base='http://127.0.0.1:7333',expected=resolve('.pulse-dev/autonomy-20261023/prepared-dev-config.json')
 const request=async(method,path,body)=>{
  const s=await fetch(base+'/api/session/local',{method:'POST',headers:{Origin:base}})
  const r=await fetch(base+path,{method,headers:{Origin:base,Cookie:s.headers.get('set-cookie'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  if(!r.ok)throw Error(`CAPABILITY_CONFIG_HTTP_${r.status}`);return r.json()
 }
 const current=await request('GET','/api/config');if(current.path!==expected)throw Error('DEV_CONFIG_PATH_MISMATCH')
 const previous=current.config.capabilities?.enabled,narrowed=(previous??[]).filter(id=>id!=='browser'&&id!=='computer')
 const save=async(snapshot,value)=>{
  if(snapshot.path!==expected)throw Error('DEV_CONFIG_PATH_MISMATCH')
  const config={...snapshot.config,capabilities:{...snapshot.config.capabilities}}
  if(value===undefined)delete config.capabilities.enabled;else config.capabilities.enabled=value
  const r=await request('PUT','/api/config',{version:snapshot.version,config})
  if(!r.applied||r.restartRequired.length)throw Error('DEV_CAPABILITY_NOT_APPLIED')
 }
 await save(current,narrowed)
 await writeFile(join(out,'capability-configuration.json'),JSON.stringify({previous,narrowed,reason:'Frozen missing browser capability regression'},null,2))
 try{return await execute()}
 finally{
  const latest=await request('GET','/api/config')
  if(JSON.stringify(latest.config.capabilities?.enabled)!==JSON.stringify(narrowed))throw Error('CAPABILITIES_CHANGED_EXTERNALLY')
  await save(latest,previous)
  await writeFile(join(out,'capability-configuration-restored.json'),JSON.stringify({restored:previous,at:new Date().toISOString()}))
 }
}

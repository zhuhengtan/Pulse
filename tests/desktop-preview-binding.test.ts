import {readFileSync} from 'node:fs'
import {expect,it} from 'vitest'
import {isOwnedService,restoreOwnedService,serviceRuntimeEnvironment} from '../packages/desktop/src/background-service.mjs'
import {launcherText} from '../packages/desktop/src/installation.mjs'
const source=readFileSync(new URL('../packages/desktop/src/main.mjs',import.meta.url),'utf8')
const ensure=source.slice(source.indexOf('    async function ensureService()'),source.indexOf('    let readerRuntime;'))
function fixture(runtimeId='old',policy='bundled'){
 return new Function('isOwnedService','restoreOwnedService',`
 let chat,browserHost,directory='/preview/data',base='',cookie='',apiSession,ownedPid,backendInfo,serviceVersionBlocked=false,serviceStoppedByUser=false,attached=0;
 const installation={source:'/bundle/runtime',runtimePolicy:${JSON.stringify(policy)},state:{version:'0.10.0',runtimeId:'preview'}};
 const descriptor={protocol:1,pid:222,port:1234,instanceId:'instance'};
 const mkdir=async()=>{},assertDesktopDataReady=async()=>{},join=(...v)=>v.join('/');
 const readFile=async path=>JSON.stringify(path==='owner'?{instanceId:'instance',launchedPid:222,pid:222}:descriptor);
 const process={kill(){}},electronSession={fromPartition:()=>({cookies:{}})},deviceSessionPartition=()=>'',restoreDeviceCookie=async()=>'',http=async path=>({ok:true,json:async()=>({serverPid:222,serverInstanceId:'instance',serverVersion:'0.10.0',runtimeId:${JSON.stringify(runtimeId)}})});
 const ownershipFile=()=> 'owner',app={getPath:()=>'/preview/profile'},writeFile=async()=>{},rename=async()=>{},ensureReader=async()=>{attached++},connectChat=async()=>{attached++},connectBrowserHost=()=>{attached++},notifications=undefined,updateTray=()=>{};
 ${ensure}
 return {run:ensureService,state:()=>({base,blocked:serviceVersionBlocked,stopped:serviceStoppedByUser,attached,outdated:backendInfo?.outdated})};
 `)(isOwnedService,restoreOwnedService)
}
it('rejects a same-semver older preview runtime before attaching any execution channel',async()=>{
 const f=fixture();await expect(f.run()).rejects.toThrow('PREVIEW_BACKEND_VERSION_MISMATCH');expect(f.state()).toMatchObject({blocked:true,stopped:true,attached:0,outdated:true})
})
it('reuses only the matching preview runtime',async()=>{const f=fixture('preview');await f.run();expect(f.state()).toMatchObject({blocked:false,attached:3,outdated:false})})
it('preserves managed release behavior',async()=>{const f=fixture('old','managed');await f.run();expect(f.state()).toMatchObject({blocked:false,attached:3,outdated:true})})
it('blocks ordinary requests while retaining only the identity handshake for an explicit switch',async()=>{
 const http=source.slice(source.indexOf('    async function http('),source.indexOf('    let chat, chatConnecting'))
 // Exercise the guard with its actual closure dependencies.
 const request=new Function(`let serviceVersionBlocked=true;${http};return http`)();await expect(request('/api/conversations/conv/messages',{method:'POST'})).rejects.toThrow('PREVIEW_BACKEND_VERSION_MISMATCH')
})
it('pins preview CLI configuration and data even when a terminal inherited another environment',()=>{
 const s=launcherText('/preview/node','/preview/app/cli.js','/preview',false,undefined,'build',{configPath:'/preview/config.json',dataDirectory:'/preview/data',pinned:true});expect(s).toContain("PULSE_HOME='/preview'; export PULSE_HOME");expect(s).toContain("PULSE_CONFIG='/preview/config.json'; export PULSE_CONFIG");expect(s).not.toContain('if [ -z')
 const win=launcherText('C:/preview/node.exe','C:/preview/app/cli.js','C:/preview',true,undefined,'build',{configPath:'C:/preview/config.json',dataDirectory:'C:/preview/data',pinned:true});expect(win).not.toContain('if not defined PULSE_HOME');expect(win).not.toContain('if not defined PULSE_CONFIG')
})

it('starts a preview directly from its packaged runtime, ignoring stale release bootstrap state',()=>{
 const installation={source:'/bundle',root:'/preview',runtimePolicy:'bundled',state:{configPath:'/preview/config.json',runtimeId:'current',runtimeDirectory:'/preview/runtime'}}
 expect(serviceRuntimeEnvironment(installation)).toMatchObject({PULSE_MANAGED:'0',PULSE_RUNTIME_ID:'current',PULSE_RUNTIME_DIR:'/preview/runtime'})
 expect(serviceRuntimeEnvironment({...installation,runtimePolicy:'managed'}).PULSE_MANAGED).toBe('1')
})

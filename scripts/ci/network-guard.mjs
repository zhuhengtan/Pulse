// CI-only boundary; sandboxed shell children retain their native OS restrictions.
import dgram from 'node:dgram';
import {errorMonitor} from 'node:events';
import {threadId} from 'node:worker_threads';
import {constants} from 'node:os';
import {promisify} from 'node:util';import net from 'node:net';import dns from 'node:dns';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync,mkdirSync,statSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {basename,join,dirname,posix,win32} from 'node:path';
const self=fileURLToPath(import.meta.url);
let srtSequence=0;
const srtOperations=new Set(['grant','stamp','revoke','restore','status','install','uninstall','remove','trust-ca','verify','probe','enable','disable']);
const srtCodes=new Set([...Object.keys(constants.errno),...Object.keys(constants.signals),'ABORT_ERR','ERR_INVALID_ARG_TYPE','ERR_OUT_OF_RANGE']);
const checkout=fileURLToPath(new URL('../../',import.meta.url));
const tracePackages=new Set(['adapters','cli','data','desktop','runtime','server','tool-sdk','web']);
const traceFolders=new Map([['.git','git'],['.github','workflows'],['.pulse-dev','build-cache'],['node_modules','dependencies'],['native','native'],['tests','tests'],['docs','docs'],['evals','evals'],['assets','assets'],['artifacts','artifacts'],['scripts','scripts'],['output','output']]);
function aclTargetKind(path){
  if(typeof path!=='string')return 'other';
  const api=/^(?:[A-Za-z]:|\\\\)/.test(path)?win32:posix;
  const within=(base)=>{const rel=api.relative(base,path);return rel===''||rel!=='..'&&!rel.startsWith('..'+api.sep)&&!api.isAbsolute(rel)};
  if(within(checkout)){
    const parts=api.relative(checkout,path).split(/[\\/]/);
    if(!parts[0])return 'checkout';
    if(parts[0]==='packages'&&tracePackages.has(parts[1]))return 'package-'+parts[1];
    return 'checkout-'+(traceFolders.get(parts[0])??'other');
  }
  if(within(api.dirname(process.execPath)))return 'node-runtime';
  if(/(?:^|[\\/])setup-pnpm(?:[\\/]|$)/i.test(path))return 'host-pnpm';
  return /(?:^|[\\/])node_modules(?:[\\/]|$)/i.test(path)?'dependencies':'other';
}
function aclBatchKinds(command,operation,options){
  if(command!=='acl'||!['stamp','grant'].includes(operation))return undefined;
  try{
    // Inspect only a plain input value; diagnostics must not trigger getters.
    const input=Object.getOwnPropertyDescriptor(options??{},'input')?.value;
    if(!(typeof input==='string'||Buffer.isBuffer(input))||input.length>65536)return undefined;
    const value=JSON.parse(input.toString()),read=value[operation==='stamp'?'denyRead':'read']??[],write=value[operation==='stamp'?'denyWrite':'write']??[];
    if(!Array.isArray(read)||!Array.isArray(write)||read.length+write.length>128||![...read,...write].every(p=>typeof p==='string'&&p.length<=32768))return undefined;
    return {readKinds:read.map(aclTargetKind),writeKinds:write.map(aclTargetKind)};
  }catch{return undefined}
}
// CI-only diagnostics: no raw paths, stdin, output, environment or command payloads;
// ACL target summaries contain only fixed enums, never input-derived names.
// Observe the original call; do not change its deadline, result, callbacks or errors.
export function traceSrtCall(kind,file,rest,invoke){
  const log=process.env.PULSE_CI_SRT_LOG,args=rest[0];
  if(!log||!Array.isArray(args)||typeof file!=='string')return invoke();
  const dispatched=args[0]==='--srt-win';
  if(!dispatched&&!['srt-win.exe','pulse-srt.exe'].includes(String(file).split(/[\\/]/).at(-1)?.toLowerCase()))return invoke();
  const command=args[dispatched?1:0],sub=args[dispatched?2:1];
  if(!['acl','user','wfp','exec'].includes(command))return invoke();
  const operation=srtOperations.has(sub)&&command!=='exec'?sub:undefined;
  const options=rest.find(value=>value&&typeof value==='object'&&!Array.isArray(value));
  const started=Date.now(),id=`${process.pid}:${threadId}:${++srtSequence}`;
  const record=extra=>{try{let size=0;try{size=statSync(log).size}catch(error){if(error.code!=='ENOENT')return}if(size<4*1024*1024)appendFileSync(log,JSON.stringify({id,pid:process.pid,threadId,time:Date.now(),elapsedMs:Date.now()-started,kind,command,operation,...extra})+'\n',{mode:0o600})}catch{/* diagnostics never change execution */}};
  const safeCode=value=>typeof value==='string'&&srtCodes.has(value)?value:undefined;
  record({phase:'start',timeoutMs:Number.isFinite(options?.timeout)?options.timeout:undefined,acl:aclBatchKinds(command,operation,options)});
  let settled=false;
  const finish=extra=>{if(!settled){settled=true;record({phase:'end',...extra})}};
  try{
    const result=invoke();
    if(kind.endsWith('Sync'))finish({status:kind==='spawnSync'?result?.status:0,signal:safeCode(result?.signal),errorCode:safeCode(result?.error?.code)});
    else{
      const child=result?.child??result;
      if(typeof child?.once==='function'){
        child.once(errorMonitor,error=>finish({errorCode:safeCode(error?.code)}));
        child.once('close',(status,signal)=>finish({status,signal:safeCode(signal)}));
      }else record({phase:'unobserved'});
    }
    return result;
  }catch(error){finish({status:Number.isInteger(error?.status)?error.status:undefined,errorCode:safeCode(error?.code)});throw error}
}
const reportPath=()=>process.env.PULSE_CI_NETWORK_LOG??fileURLToPath(new URL('../../.pulse-dev/ci-network-attempts.jsonl',import.meta.url));
const local=h=>h===undefined||h===null||h===''||['localhost','127.0.0.1','::1','[::1]','0.0.0.0'].includes(String(h));
function reject(host){const report=reportPath();mkdirSync(dirname(report),{recursive:true});appendFileSync(report,JSON.stringify({pid:process.pid,host:String(host),time:Date.now()})+'\n');throw Object.assign(new Error('UNEXPECTED_EXTERNAL_NETWORK_BLOCKED:'+host),{code:'OFFLINE_NETWORK_BLOCKED'});}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let first=args[0];if(Array.isArray(first))first=first[0];if(first&&typeof first==='object'){if(first.port!==undefined&&!local(first.host))reject(first.host);}else if(typeof first==='number'&&!local(args[1])&&typeof args[1]!=='function')reject(args[1]);return Reflect.apply(connect,this,args);};
const lookup=dns.lookup;dns.lookup=function(host,...args){if(!local(host))reject(host);return Reflect.apply(lookup,this,[host,...args]);};
for(const key of ['spawn','spawnSync','execFile','execFileSync']){const original=cp[key];cp[key]=function(file,...rest){if(['npx', 'npx.cmd', 'npx.exe', 'uvx', 'uvx.cmd', 'uvx.exe', 'pnpx', 'pnpx.cmd', 'pnpx.exe', 'yarn', 'yarn.cmd', 'yarn.exe', 'corepack', 'corepack.cmd', 'corepack.exe', 'bun', 'bun.cmd', 'bun.exe', 'uv', 'uv.cmd', 'uv.exe', 'pip', 'pip.cmd', 'pip.exe', 'pip3', 'pip3.cmd', 'pip3.exe'].includes(basename(String(file))))throw Error('OFFLINE_PACKAGE_MANAGER_LAUNCH_BLOCKED');if(['node','node.exe'].includes(basename(String(file)))||file===process.execPath){if(Array.isArray(rest[0])&&!rest[0].some(x=>String(x)==='--import='+import.meta.url||String(x).includes(self)))rest[0]=['--import='+import.meta.url,...rest[0]];}return traceSrtCall(key,file,rest,()=>Reflect.apply(original,this,[file,...rest]));};if(original[promisify.custom])cp[key][promisify.custom]=function(file,...rest){if(['npx', 'npx.cmd', 'npx.exe', 'uvx', 'uvx.cmd', 'uvx.exe', 'pnpx', 'pnpx.cmd', 'pnpx.exe', 'yarn', 'yarn.cmd', 'yarn.exe', 'corepack', 'corepack.cmd', 'corepack.exe', 'bun', 'bun.cmd', 'bun.exe', 'uv', 'uv.cmd', 'uv.exe', 'pip', 'pip.cmd', 'pip.exe', 'pip3', 'pip3.cmd', 'pip3.exe'].includes(basename(String(file))))throw Error('OFFLINE_PACKAGE_MANAGER_LAUNCH_BLOCKED');if(['node','node.exe'].includes(basename(String(file)))||file===process.execPath){if(Array.isArray(rest[0])&&!rest[0].some(x=>String(x)==='--import='+import.meta.url||String(x).includes(self)))rest[0]=['--import='+import.meta.url,...rest[0]];}return traceSrtCall(key,file,rest,()=>Reflect.apply(original[promisify.custom],this,[file,...rest]));};}
const promiseLookup=dns.promises.lookup;dns.promises.lookup=function(host,...args){if(!local(host))reject(host);return Reflect.apply(promiseLookup,this,[host,...args]);};
// DNS Resolver instances and UDP must not bypass the TCP/lookup boundary.
const dnsMethods=['resolve','resolve4','resolve6','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse','lookupService'];
for(const target of [dns,dns.promises,dns.Resolver?.prototype,dns.promises.Resolver?.prototype]) for(const method of dnsMethods){if(typeof target?.[method]!=='function')continue;const original=target[method];target[method]=function(host,...args){reject('dns:'+method+':'+host);};}
for(const method of ['send','connect']){dgram.Socket.prototype[method]=function(){reject('udp:'+method);};}
syncBuiltinESMExports();

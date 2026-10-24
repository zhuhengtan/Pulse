import {lstat,realpath} from 'node:fs/promises'
import {basename,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {FilesystemTool} from '@hunterzhu/pulse-adapters'
import {within} from '../security.js'

type CopyEntry={source:string;path:string;sourceHash:string;beforeHash:string|null}
export type CopySnapshot={schemaVersion:1;operation:'copy';entries:CopyEntry[]}
export type CopyChanges={schemaVersion:1;operation:'copy';entries:Array<CopyEntry&{hash:string}>}
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)

/** Only bounded, direct regular-file cp operands are observable here. */
export async function captureCopy(root:string,cwd:string,command:string,args:string[]):Promise<CopySnapshot|undefined>{
 if(!['cp','/bin/cp','/usr/bin/cp'].includes(command)||args.length>34)return undefined
 const operands:string[]=[];let literal=false
 for(const arg of args){
  if(!literal&&arg==='--'){literal=true;continue}
  if(!literal&&arg.startsWith('-')){if(arg==='-p')continue;return undefined}
  operands.push(arg)
 }
 if(operands.length<2||operands.length>33)return undefined
 try{
  const base=await realpath(root),files=new FilesystemTool(base)
  const operandPath=(operand:string)=>{
   const path=resolve(cwd,operand),scope=relative(resolve(root),path)
   return scope!=='..'&&!scope.startsWith(`..${sep}`)&&!isAbsolute(scope)?resolve(base,scope):path
  }
  const destination=operandPath(operands.at(-1)!)
  await within(base,destination)
  const destStat=await lstat(destination).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
  if(destStat?.isSymbolicLink()||destStat&&!destStat.isFile()&&!destStat.isDirectory()||operands.length>2&&!destStat?.isDirectory())return undefined
  const entries:CopyEntry[]=[];let totalBytes=0
  for(const operand of operands.slice(0,-1)){
   const source=operandPath(operand);await within(base,source)
   const sourceStat=await lstat(source)
   totalBytes+=sourceStat.size
   if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.size>8*1024*1024||totalBytes>64*1024*1024)return undefined
   const target=destStat?.isDirectory()?join(destination,basename(source)):destination
   await within(base,target)
   const targetStat=await lstat(target).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
   if(targetStat&&(!targetStat.isFile()||targetStat.isSymbolicLink()||targetStat.size>8*1024*1024)||source===target)return undefined
   entries.push({source:relative(base,source),path:relative(base,target),sourceHash:await files.hash(source),beforeHash:targetStat?await files.hash(target):null})
  }
  if(new Set(entries.map(entry=>entry.path)).size!==entries.length)return undefined
  return{schemaVersion:1,operation:'copy',entries}
 }catch{return undefined}
}

export async function finishCopy(root:string,before:CopySnapshot|undefined,result:{code:number|null;timedOut?:boolean;aborted?:boolean;truncated?:boolean}):Promise<CopyChanges|undefined>{
 if(!before||result.code!==0||result.timedOut||result.aborted||result.truncated)return undefined
 const files=new FilesystemTool(root),entries:CopyChanges['entries']=[]
 try{
  for(const entry of before.entries){
   const hash=await files.hash(entry.path)
   if(hash!==entry.sourceHash||await files.hash(entry.source)!==entry.sourceHash)return undefined
   if(entry.beforeHash!==hash)entries.push({...entry,hash})
  }
  return{schemaVersion:1,operation:'copy',entries}
 }catch{return undefined}
}

/** Host tool properties only; stdout and model declarations never create proof. */
export function copyChanges(value:unknown):CopyChanges['entries']{
 if(!value||typeof value!=='object'||Array.isArray(value))return[]
 const body=value as Record<string,any>,receipt=body.fileChanges
 if(body.code!==0||body.timedOut||body.aborted||body.truncated||receipt?.schemaVersion!==1||receipt.operation!=='copy'||!Array.isArray(receipt.entries)||receipt.entries.length>32)return[]
 if(!receipt.entries.every((entry:any)=>entry&&typeof entry.path==='string'&&typeof entry.source==='string'&&digest(entry.hash)&&entry.sourceHash===entry.hash&&(entry.beforeHash===null||digest(entry.beforeHash))&&entry.beforeHash!==entry.hash))return[]
 return receipt.entries
}

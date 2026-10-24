import {basename} from 'node:path'

/** Conservative classification of observed Node argv, never inferred success. */
export function classifyScriptInvocation(command,args,script){
 const normalize=value=>String(value).replace(/^\.\//,'')
 const values=Array.isArray(args)?args.map(normalize):[]
 if(!values.some(value=>value.includes(script)))return'other'
 if(basename(command??'')!=='node')return'unknown'
 if(values.length===1&&values[0]===script)return'execution'
 if(values.length===2&&['--check','-c'].includes(values[0])&&values[1]===script)return'syntax-only'
 return'unknown'
}

import {expect,it} from 'vitest'
import {classifyScriptInvocation} from '../scripts/eval/autonomy-command-invocation.mjs'

const script='scripts/step1-migrate-users.mjs'
it.each(['node','/usr/bin/node'])('counts a direct script execution with %s',command=>{
 expect(classifyScriptInvocation(command,[script],script)).toBe('execution')
 expect(classifyScriptInvocation(command,['./'+script],script)).toBe('execution')
})
it.each(['--check','-c'])('does not count %s as executing the script',flag=>{
 expect(classifyScriptInvocation('node',[flag,script],script)).toBe('syntax-only')
})
it.each([['--test',script],['--eval',`import('./${script}')`],['--require','hook.cjs',script]])('does not silently accept ambiguous or indirect execution: %j',(...args)=>{
 expect(classifyScriptInvocation('node',args,script)).toBe('unknown')
})
it('keeps other interpreters unknown and unrelated commands separate',()=>{
 expect(classifyScriptInvocation('python',[script],script)).toBe('unknown')
 expect(classifyScriptInvocation('node',['--test','test/verify.test.mjs'],script)).toBe('other')
})
it('still counts two actual executions as two',()=>{
 const rows=[['--check',script],[script],['./'+script]]
 expect(rows.filter(args=>classifyScriptInvocation('node',args,script)==='execution')).toHaveLength(2)
})

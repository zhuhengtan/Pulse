import { expect, it } from 'vitest'
import { boundedAssistantConversation } from '../packages/server/src/assistant-chat-context.js'
it.each(['a'.repeat(24_000), '汉'.repeat(15_000) + '最后改成Beta', '😀'.repeat(15_000) + '不要Alpha'])('preserves the complete current request while reducing history', text => {
  const result = boundedAssistantConversation([{role:'assistant',content:'history'.repeat(6000)},{role:'user',content:text}])
  expect(result.at(-1)?.content).toBe(text)
  expect(result.reduce((sum,m)=>sum+Buffer.byteLength(m.content),0)).toBeLessThanOrEqual(Math.max(24_000,Buffer.byteLength(text)))
  expect(result.some(m=>m.content.includes('\uFFFD'))).toBe(false)
})
it('preserves multiple in-flight corrections and bounds old multibyte history',()=>{
 const priority=[{role:'user' as const,content:'纠正'.repeat(3000)+'FIRST'},{role:'user' as const,content:'😀'.repeat(2000)+'SECOND'}]
 const result=boundedAssistantConversation([{role:'assistant',content:'旧'.repeat(15000)},...priority],2)
 expect(result.slice(-2)).toEqual(priority);expect(result.some(m=>m.content.includes('\uFFFD'))).toBe(false)
})
it('keeps the recent message count bounded without dropping current intent',()=>{const input=Array.from({length:60},(_,i)=>({role:'user' as const,content:'message '+i}));expect(boundedAssistantConversation(input)).toEqual(input.slice(-40))})
it('rejects an oversized live context explicitly instead of silently truncating it',()=>{expect(()=>boundedAssistantConversation([{role:'user',content:'😀'.repeat(32_001)}])).toThrow('ASSISTANT_CONTEXT_TOO_LARGE')})
it.each(['x'.repeat(24_001), '汉'.repeat(25_000)])('retains the current reference with a long request and live corrections', text => {
 const reference='[Current UI reference]\n{"project":{"id":"project-selected"},"conversation":{"id":"conversation-selected"}}'
 const updates=[{role:'user' as const,content:text},{role:'user' as const,content:'只读，不要修改'}]
 const result=boundedAssistantConversation([{role:'assistant',content:'old history'},...updates],2,reference)
 expect(result).toEqual([updates[0],{role:'user',content:reference},updates[1]])
 expect(result.at(-1)?.content).toBe('只读，不要修改')
})
it('counts the pinned reference toward the live byte and message limits',()=>{
 expect(()=>boundedAssistantConversation([{role:'user',content:'x'.repeat(128_000)}],1,'reference')).toThrow('ASSISTANT_CONTEXT_TOO_LARGE')
 const messages=Array.from({length:50},(_,i)=>({role:'user' as const,content:String(i)}))
 const result=boundedAssistantConversation(messages,1,'current reference')
 expect(result).toHaveLength(40);expect(result.slice(-2)).toEqual([{role:'user',content:'current reference'},messages.at(-1)])
})

import { expect, it } from 'vitest'
import { speechSentences } from '../packages/desktop/src/voice/sentences.mjs'
import { cleanSpeech } from '../packages/desktop/src/voice/local-engine.mjs'
it('keeps sentence endings and quotes and never splits a sentence by character count', () => {
 expect(speechSentences('你好，小强！他说：“可以。”接下来怎么办？')).toEqual(['你好，小强！','他说：“可以。”','接下来怎么办？'])
 const long = '这是完整句子中的一部分，'.repeat(40) + '结束。'
 expect(speechSentences(long)).toEqual([long])
})
it('does not split decimals, ordinary abbreviations or URLs', () => {
 expect(speechSentences('Dr. Smith uses version 3.14. It works! Visit example.com now.')).toEqual(['Dr. Smith uses version 3.14.','It works!','Visit example.com now.'])
})
it('removes DC and edge discontinuities without changing length or introducing nonfinite samples', () => {
 const rate = 24000, source = Float32Array.from({length:rate},(_,i)=>.04+.2*Math.sin(2*Math.PI*440*i/rate))
 const result = cleanSpeech(source,rate)
 expect(result).toHaveLength(source.length); expect(result[0]).toBe(0); expect(Math.abs(result.at(-1))).toBe(0)
 expect(Math.abs(result.reduce((a,b)=>a+b,0)/rate)).toBeLessThan(.001)
 expect(Math.max(...result)).toBeGreaterThan(.18)
 expect(() => cleanSpeech(Float32Array.of(NaN),rate)).toThrow('VOICE_AUDIO_INVALID')
})

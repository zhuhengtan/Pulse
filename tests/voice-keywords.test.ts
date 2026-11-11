import { expect, it } from 'vitest'
import { keywordPronunciations, keywordTokens } from '../packages/desktop/src/voice/keywords.mjs'
const lexicon = new Map([['P', ['P', 'IY1']], ['PULSE', ['P', 'AH1', 'L', 'S']]])
const tokens = new Set(['x', 'iǎo', 'p', 'í', 'ī', 'ì', 'P', 'IY1', 'AH1', 'L', 'S', 'q', 'iáng'])
it('keeps English letter pronunciation and adds common Chinese readings for mixed names', () => {
  expect(keywordPronunciations('小P', lexicon, tokens)).toEqual(['x iǎo P IY1', 'x iǎo p í', 'x iǎo p ī', 'x iǎo p ì'])
  expect(keywordPronunciations('小p', lexicon, tokens)).toEqual(keywordPronunciations('小P', lexicon, tokens))
})
it('keeps whole English words and Chinese names unchanged', () => {
  expect(keywordPronunciations('Pulse', lexicon, tokens)).toEqual(['P AH1 L S'])
  expect(keywordPronunciations('小强', lexicon, tokens)).toEqual(['x iǎo q iáng'])
  expect(keywordPronunciations('小 Pulse', lexicon, tokens)).toEqual([keywordTokens('小 Pulse', lexicon, tokens)])
})
it('rejects unsupported primary names and ignores unsupported optional aliases', () => {
  expect(() => keywordPronunciations('Unknown', lexicon, tokens)).toThrow('词典中没有')
  expect(keywordPronunciations('小P', lexicon, new Set(['x', 'iǎo', 'P', 'IY1']))).toEqual(['x iǎo P IY1'])
  expect(() => keywordPronunciations('小P!', lexicon, tokens)).toThrow('中文或英文单词')
})

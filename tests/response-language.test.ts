import { describe, expect, it } from 'vitest'
import { detectResponseLanguage, responseLanguageInstruction } from '../packages/server/src/language.js'

describe('response language selection', () => {
  it('selects simplified Chinese for a Chinese request', () => {
    expect(detectResponseLanguage('请帮我修复这个 CLI 问题')).toBe('zh-CN')
    expect(responseLanguageInstruction('zh-CN')).toContain('Simplified Chinese')
  })

  it('keeps English for an English request', () => {
    expect(detectResponseLanguage('Please fix this CLI issue')).toBe('en')
    expect(responseLanguageInstruction('en')).toContain('same language')
  })
})

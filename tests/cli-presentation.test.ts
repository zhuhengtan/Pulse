import { mouseEvent } from '../packages/cli/src/utils/mouse.js'
import { describe, expect, it } from 'vitest'
import { transcriptLines, scrollAction } from '../packages/cli/src/utils/transcript.js'
import { stripAnsi } from '../packages/cli/src/utils/ansi.js'

describe('CLI transcript presentation', () => {
  it('handles wheel reports without treating clicks, release or horizontal scrolling as vertical motion', () => {
    expect(mouseEvent('\x1b[<64;20;8M')).toEqual({ wheel: -3 })
    expect(mouseEvent('[<65;20;8M')).toEqual({ wheel: 3 })
    expect(mouseEvent('[<68;20;8M')).toEqual({ wheel: -3 })
    for (const code of ['[<0;20;8M', '[<64;20;8m', '[<66;20;8M']) expect(mouseEvent(code)).toEqual({ wheel: 0 })
    expect(mouseEvent('normal text')).toBeUndefined()
  })
  it('supports Mac paging without stealing cursor or input-history keys', () => {
    expect(scrollAction('p', { ctrl: true })).toBe('up')
    expect(scrollAction('n', { ctrl: true })).toBe('down')
    expect(scrollAction('g', { ctrl: true })).toBe('bottom')
    expect(scrollAction('', { pageUp: true })).toBe('up')
    expect(scrollAction('', { upArrow: true })).toBeUndefined()
  })
  it('wraps a single long Chinese response into scrollable lines including its end', () => {
    const text = '中文内容'.repeat(200) + '\n最终一行'
    const lines = transcriptLines([{ id: '1', role: 'assistant', text, createdAt: '' }], 40)
    expect(lines.length).toBeGreaterThan(30)
    expect(stripAnsi(lines.at(-1)!)).toContain('最终一行')
    expect(lines.map(stripAnsi).join('')).toContain('中文内容')
  })
  it('collapses completed tools and never renders private thinking as answer text', () => {
    const message = { id: '1', role: 'assistant' as const, text: '最终回答', thinking: 'PRIVATE', createdAt: '', toolCalls: [{ id: 't', name: 'fs.read', status: 'succeeded' as const, arguments: { path: 'a.txt' } }] }
    const normal = transcriptLines([message], 80).join('\n')
    expect(normal).toContain('1/1 已完成')
    expect(normal).not.toContain('展开详情')
    expect(normal).not.toContain('PRIVATE')
    expect(normal).not.toContain('a.txt')
    expect(transcriptLines([message], 80, 'verbose').join('\n')).toContain('a.txt')
  })
})

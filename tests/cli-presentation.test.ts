import { mouseEvent } from '../packages/cli/src/utils/mouse.js'
import { describe, expect, it } from 'vitest'
import { transcriptLines, scrollAction } from '../packages/cli/src/utils/transcript.js'
import { stripAnsi } from '../packages/cli/src/utils/ansi.js'
import { formatInstallWelcome, formatVersionOutput, shouldUseColor } from '../packages/cli/src/presentation.js'

describe('CLI presentation', () => {
  it('shows bilingual release highlights for a known version', () => {
    const output = formatVersionOutput('0.4.0')

    expect(output).toContain('Pulse v0.4.0')
    expect(output).toContain('本版本亮点 / What’s new in this version')
    expect(output).toContain('默认使用异步并行 event loop')
    expect(output).toContain('asynchronous, parallel event loop')
    expect(output).toContain('██████╗')
  })

  it('shows a bilingual fallback when a version has no highlights', () => {
    const output = formatVersionOutput('99.0.0')

    expect(output).toContain('暂无此版本的更新亮点记录。')
    expect(output).toContain('No release highlights are available for this version yet.')
  })

  it('shows bilingual install messages for both config outcomes', () => {
    const success = formatInstallWelcome({ version: '0.4.0', configPath: '/tmp/.pulse/config.json' })
    expect(success).toContain('开始使用 / Get started:')
    expect(success).toContain('配置已就绪 / Configuration ready at:')
    expect(success).toContain('/tmp/.pulse/config.json')

    const failure = formatInstallWelcome({ version: '0.4.0', error: 'permission denied' })
    expect(failure).toContain('配置创建失败 / Configuration could not be created: permission denied')
    expect(failure).toContain('稍后运行 "pulse setup" 创建配置。 / Run "pulse setup" later to create it.')
  })

  it('respects terminal color settings', () => {
    expect(shouldUseColor({}, true)).toBe(true)
    expect(shouldUseColor({ NO_COLOR: '1' }, true)).toBe(false)
    expect(shouldUseColor({ FORCE_COLOR: '1' }, false)).toBe(true)
    expect(shouldUseColor({ FORCE_COLOR: '0' }, true)).toBe(false)
    expect(formatVersionOutput('0.4.0', { color: true })).toContain('\u001b[36m')
  })
})

describe('CLI transcript presentation', () => {
  it('handles wheel reports without treating clicks, release or horizontal scrolling as vertical motion', () => {
    expect(mouseEvent('\x1b[<64;20;8M')).toMatchObject({ phase: 'wheel', wheel: -3 })
    expect(mouseEvent('[<65;20;8M')).toMatchObject({ phase: 'wheel', wheel: 3 })
    expect(mouseEvent('[<68;20;8M')).toMatchObject({ phase: 'wheel', wheel: -3 })
    expect(mouseEvent('[<0;20;8M')?.phase).toBe('press')
    expect(mouseEvent('[<0;20;8m')?.phase).toBe('release')
    expect(mouseEvent('[<66;20;8M')?.phase).toBe('press')
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
  it('renders a compact chat transcript and groups repeated tool calls', () => {
    const lines = transcriptLines([
      { id: 'u', role: 'user', text: '检查变更', createdAt: '' },
      { id: 'run-activity-r', role: 'system', text: '正在查看变更…', createdAt: '' },
      { id: 'a', role: 'assistant', text: '总结如下。', createdAt: '', toolCalls: [
        { id: 't1', name: 'shell.exec', status: 'succeeded', arguments: {} },
        { id: 't2', name: 'shell.exec', status: 'succeeded', arguments: {} },
        { id: 't3', name: 'task.evidence', status: 'failed', arguments: {}, result: { code: 'EFFECT_FAILED', message: 'RESULT_NOT_VISIBLE' } },
      ] },
    ], 100).map(stripAnsi)
    const rendered = lines.join('\n')
    expect(rendered).toContain('❯ 你发来')
    expect(rendered).toContain('Pulse')
    expect(rendered).toContain('shell.exec × 2 · 已完成')
    expect(rendered).toContain('task.evidence · 失败 · RESULT_NOT_VISIBLE')
    expect(rendered).not.toContain('┌─')
    expect(rendered).not.toContain('╭─')
    expect(rendered.match(/shell\.exec/g)).toHaveLength(1)
  })
})

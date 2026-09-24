import { describe, expect, it } from 'vitest'
import { describeFactStatus } from '../packages/cli/src/hooks/useRun.js'
import { clipboardCommands, isCopyShortcut, sanitizeClipboardText } from '../packages/cli/src/utils/clipboard.js'
import { mouseEvent } from '../packages/cli/src/utils/mouse.js'
import { selectedLine, selectedText } from '../packages/cli/src/utils/selection.js'
import { stripTerminalControls } from '../packages/cli/src/utils/ansi.js'
import { transcriptLines } from '../packages/cli/src/utils/transcript.js'
import { emptyInputHistory, navigateInputHistory, rememberInput } from '../packages/cli/src/utils/inputHistory.js'

describe('CLI human input status projection', () => {
  it('shows actionable status for received and dispatched input facts', () => {
    expect(describeFactStatus({ inputId: 'input-1', priority: 'human' })).toContain('已收到你的输入')
    expect(describeFactStatus({ inputId: 'input-1', decision: 'spawn' })).toContain('优先交互任务')
    expect(describeFactStatus({ inputId: 'input-1', action: 'steer' })).toContain('调整当前任务')
    expect(describeFactStatus({ inputId: 'input-1', decision: 'defer', reason: '副作用执行中' })).toContain('安全时机')
  })

  it('keeps ordinary facts readable and does not expose raw objects in the prompt', () => {
    expect(describeFactStatus('tool.completed')).toBe('tool.completed')
    expect(describeFactStatus({ type: 'unknown' })).toBe('正在执行...')
  })
})

describe('CLI clipboard support', () => {
  it('selects a native clipboard utility for each supported desktop platform', () => {
    expect(clipboardCommands('darwin')).toEqual([{ file: 'pbcopy', args: [] }])
    expect(clipboardCommands('win32')).toEqual([{ file: 'clip.exe', args: [] }])
    expect(clipboardCommands('linux')).toEqual([{ file: 'wl-copy', args: [] }, { file: 'xclip', args: ['-selection', 'clipboard'] }])
    expect(clipboardCommands('freebsd')).toEqual([])
  })

  it('recognizes copy shortcuts without treating ordinary keys as copy', () => {
    expect(isCopyShortcut('c', { meta: true })).toBe(true)
    expect(isCopyShortcut('\u0003', { ctrl: true })).toBe(true)
    expect(isCopyShortcut('x', { meta: true })).toBe(false)
    expect(isCopyShortcut('c', {})).toBe(false)
  })

  it('removes invisible paste artifacts while preserving emoji and line breaks', () => {
    expect(sanitizeClipboardText('第一\u200B行\u00A0内容\u202F\u2060\uFEFF\u00AD\r\n👩‍💻'))
      .toBe('第一行 内容 \n👩‍💻')
  })

  it('keeps wheel events and reports drag selection coordinates', () => {
    expect(mouseEvent('\u001b[<64;9;4M')).toMatchObject({ phase: 'wheel', wheel: -3, x: 8, y: 3 })
    expect(mouseEvent('\u001b[<0;4;2M')).toMatchObject({ phase: 'press', x: 3, y: 1 })
    expect(mouseEvent('\u001b[<32;7;5M')).toMatchObject({ phase: 'drag', x: 6, y: 4 })
    expect(mouseEvent('\u001b[<0;7;5m')).toMatchObject({ phase: 'release' })
  })

  it('copies selected visible rows as plain text, including CJK and removing terminal styling', () => {
    const lines = ['\u001b[36m你发来\u001b[39m', '第一行', '第二行']
    expect(selectedText(lines, { start: { line: 1, column: 0 }, end: { line: 2, column: 6 } })).toBe('第一行\n第二行')
    expect(selectedText(lines, { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } })).toBe('你发')
    const highlighted = selectedLine(lines[0]!, 0, { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } })
    expect(highlighted).not.toContain('\u001b[7m')
    expect(stripTerminalControls(highlighted)).toBe('你发来')
  })
})

describe('CLI transcript roles', () => {
  it('marks user, assistant, progress and provisional output with different labels', () => {
    const lines = transcriptLines([
      { id: 'u', role: 'user', text: '请检查', createdAt: '' },
      { id: 'a', role: 'assistant', text: '正在生成', streamStatus: 'streaming', createdAt: '' },
      { id: 's', role: 'system', text: '进度 · 正在调用工具', createdAt: '' },
    ], 60)
    const visible = lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '')
    expect(visible).toContain('你发来')
    expect(visible).toContain('Pulse')
    expect(visible).toContain('正在生成')
    expect(visible).toContain('进度')
  })

  it('shows tool names and live status inside the assistant transcript', () => {
    const lines = transcriptLines([{ id: 'a', role: 'assistant', text: '', createdAt: '', toolCalls: [
      { id: 't1', name: 'fs.search', status: 'running', arguments: {} },
      { id: 't2', name: 'fs.read', status: 'succeeded', arguments: {} },
    ] }], 80).join('\n').replace(/\u001b\[[0-9;]*m/g, '')
    expect(lines).toContain('fs.search · 正在调用')
    expect(lines).toContain('fs.read · 已完成')
  })
})

describe('CLI input history', () => {
  it('moves up and down through submitted messages and restores the in-progress draft', () => {
    let state = rememberInput(rememberInput(emptyInputHistory(), 'first message'), 'second message')
    let navigation = navigateInputHistory(state, 'up', 'unfinished draft')
    state = navigation.state
    expect(navigation.value).toBe('second message')

    navigation = navigateInputHistory(state, 'up', 'second message')
    state = navigation.state
    expect(navigation.value).toBe('first message')

    navigation = navigateInputHistory(state, 'down', 'first message')
    state = navigation.state
    expect(navigation.value).toBe('second message')

    navigation = navigateInputHistory(state, 'down', 'second message')
    expect(navigation.value).toBe('unfinished draft')
    expect(navigation.state.position).toBeNull()
  })
})

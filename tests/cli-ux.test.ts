import { describe, expect, it } from 'vitest'
import { describeFactStatus } from '../packages/cli/src/hooks/useRun.js'

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

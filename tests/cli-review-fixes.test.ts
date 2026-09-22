import { describe, expect, it } from 'vitest'
import { describeApprovalTool } from '../packages/cli/src/utils/approval.js'
import { stripTerminalControls } from '../packages/cli/src/utils/ansi.js'

describe('approval preview', () => {
  it('shows the write path, length, and a truncation notice', () => {
    const content = 'a'.repeat(1_200)
    const preview = describeApprovalTool({ name: 'fs.write', input: { path: 'notes/secret.txt', content } })
    expect(preview.body).toContain('路径: notes/secret.txt')
    expect(preview.body).toContain('1200 个字符')
    expect(preview.truncated).toBe(true)
    expect(preview.body).toContain('批准会执行完整内容')
    expect(preview.body).not.toContain('a'.repeat(1_200))
  })

  it('shows the patch path', () => {
    const preview = describeApprovalTool({
      name: 'fs.apply_patch',
      input: { path: 'src/app.ts', find: 'old', replace: 'new', all: false },
    })
    expect(preview.body).toContain('路径: src/app.ts')
    expect(preview.body).toContain('- old')
    expect(preview.body).toContain('+ new')
    expect(preview.truncated).toBe(false)
  })
})

describe('terminal control filtering', () => {
  it('removes OSC and CSI sequences from untrusted text', () => {
    const text = `hello \u001B]0;owned\u0007world \u001B[31mred\u001B[0m`
    expect(stripTerminalControls(text)).toBe('hello world red')
  })
})

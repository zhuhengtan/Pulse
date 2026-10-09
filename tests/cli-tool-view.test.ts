import { describe, expect, it } from 'vitest'
import { mergeToolCall } from '../packages/cli/src/hooks/useRun.js'
import { stripAnsi } from '../packages/cli/src/utils/ansi.js'
import { describeApprovalTool } from '../packages/cli/src/utils/approval.js'
import { transcriptLines } from '../packages/cli/src/utils/transcript.js'
import { consumeToolEvent, renderToolCalls, runningToolCalls } from '../packages/cli/src/utils/tool-view.js'

function visible(calls: Parameters<typeof renderToolCalls>[0]): string {
  return stripAnsi(renderToolCalls(calls, { width: 80 }).lines.join('\n'))
}

describe('CLI tool diff view', () => {
  it('renders a patch as a colored line diff and hides the baseline hash', () => {
    const lines = renderToolCalls([{
      id: 'patch',
      name: 'fs.apply_patch',
      status: 'succeeded',
      arguments: { path: 'src/app.ts', find: 'return old', replace: 'return next', expectedHash: 'ab'.repeat(32) },
    }], { width: 80 })
    const text = stripAnsi(lines.lines.join('\n'))
    expect(text).toContain('编辑')
    expect(text).toContain('src/app.ts')
    expect(text).toContain('+1')
    expect(text).toContain('−1')
    expect(text).toContain('│- return old')
    expect(text).toContain('│+ return next')
    const failed = visible([{ id: 'patch', name: 'fs.apply_patch', status: 'failed', arguments: { path: 'src/app.ts', find: 'return old', replace: 'return next' }, result: { code: 'PATCH_CONTEXT_NOT_FOUND', message: 'PATCH_CONTEXT_NOT_FOUND' } }])
    expect(failed).toContain('│- return old')
    expect(failed).toContain('失败 · PATCH_CONTEXT_NOT_FOUND')
    expect(text).not.toContain('abab')
    expect(lines.lines.join('\n')).toContain('return old')
    expect(lines.lines.join('\n')).toContain('return next')
  })

  it('shows every fragment in one file edit', () => {
    const text = visible([{
      id: 'batch',
      name: 'fs.apply_patches',
      status: 'succeeded',
      arguments: {
        path: 'src/app.ts',
        patches: [
          { find: 'one', replace: 'two' },
          { find: 'three', replace: 'four' },
        ],
      },
    }])
    expect(text).toContain('│- one')
    expect(text).toContain('│+ two')
    expect(text).toContain('│- three')
    expect(text).toContain('│+ four')
    expect(text).toContain('@@')
  })

  it('clips a new file and strips terminal controls from the diff', () => {
    const content = `${'a'.repeat(200)}\u001B[31mred`
    const view = renderToolCalls([{ id: 'write', name: 'fs.write', status: 'running', arguments: { path: 'notes/secret.txt', content } }], { width: 100 })
    const text = stripAnsi(view.lines.join('\n'))
    expect(text).toContain('新建')
    expect(text).toContain('notes/secret.txt')
    expect(text).not.toContain('\u001B')
    expect(text).not.toContain('a'.repeat(200))
    expect(view.truncated).toBe(true)
  })

  it('prints the shell command and a bounded preview', () => {
    const text = visible([{
      id: 'shell',
      name: 'shell.exec',
      status: 'succeeded',
      arguments: { command: 'pnpm', args: ['test', 'cli tool'], cwd: 'packages/cli' },
      preview: { exitCode: 0, output: '2 passed' },
    }])
    expect(text).toContain('运行')
    expect(text).toContain("pnpm test 'cli tool'")
    expect(text).toContain('目录 packages/cli')
    expect(text).toContain('2 passed')
  })

  it('keeps parallel calls as separate rows and reads the size preview', () => {
    const text = visible([
      { id: 'a', name: 'fs.read', status: 'succeeded', arguments: { path: 'a.txt' }, preview: { bytes: 1200, lines: 40 } },
      { id: 'b', name: 'fs.read', status: 'running', arguments: { path: 'b.txt' } },
      { id: 'c', name: 'fs.search', status: 'succeeded', arguments: { query: 'renderToolCalls' }, preview: { matched: 2, locations: ['src/a.ts:3', 'src/b.ts:9'] } },
    ])
    expect(text).toContain('读取')
    expect(text).toContain('a.txt')
    expect(text).toContain('1.2 KB')
    expect(text).toContain('40 行')
    expect(text).toContain('◐')
    expect(text).toContain('b.txt')
    expect(text).toContain('2 处')
    expect(text).toContain('src/a.ts:3')
    expect(text.match(/读取/g)).toHaveLength(2)
  })

  it('projects every in-flight tool and does not let a later snapshot erase it', () => {
    const running = runningToolCalls({
      type: 'lane.snapshot',
      lanes: [{
        id: 'lane',
        status: 'running',
        activities: [
          { activityKind: 'tool', activity: 'fs.apply_patch', activityToolCallId: 'patch-1', activityArguments: { path: 'a.ts', find: 'old', replace: 'new' } },
          { activityKind: 'tool', activity: 'shell.exec', activityToolCallId: 'shell-1', activityArguments: { command: 'pnpm', args: ['test'] } },
        ],
      }],
    })
    expect(running.map((call) => call.id)).toEqual(['patch-1', 'shell-1'])
    const settled = mergeToolCall(running[0], { id: 'patch-1', name: 'fs.apply_patch', status: 'succeeded', arguments: {} }, 'settled')
    expect(settled.status).toBe('succeeded')
    expect(settled.arguments).toEqual({ path: 'a.ts', find: 'old', replace: 'new' })
    const ignored = mergeToolCall(settled, { id: 'patch-1', name: 'fs.apply_patch', status: 'running', arguments: {} }, 'running')
    expect(ignored).toBe(settled)
  })

  it('prints each one-shot tool line once per status and skips jsonl callers that do not ask', () => {
    const printed = new Set<string>()
    const first = consumeToolEvent({ type: 'observation', data: { tool: 'shell.exec', toolCallId: 's', args: { command: 'pwd' }, status: 'succeeded', preview: { output: 'here' } } }, printed, 80)
    const repeat = consumeToolEvent({ type: 'observation', data: { tool: 'shell.exec', toolCallId: 's', args: { command: 'pwd' }, status: 'succeeded', preview: { output: 'here' } } }, printed, 80)
    expect(stripAnsi(first.join('\n'))).toContain('pwd')
    expect(stripAnsi(first.join('\n'))).toContain('here')
    expect(repeat).toEqual([])
  })

  it('keeps the approval diff and the full-content warning', () => {
    const preview = describeApprovalTool({ name: 'fs.apply_patch', input: { path: 'src/app.ts', find: 'old', replace: 'new\u001B[2J' } })
    expect(preview.truncated).toBe(false)
    expect(preview.body).toContain('src/app.ts')
    expect(preview.body).not.toContain('\u001B')
    const lines = transcriptLines([{
      id: 'a',
      role: 'assistant',
      text: '完成。',
      createdAt: '',
      toolCalls: [{ id: 't', name: 'fs.write', status: 'succeeded', arguments: { path: 'out.txt', content: 'hello' } }],
    }], 80, 'verbose').join('\n')
    expect(lines).toContain('│+ hello')
    expect(stripAnsi(lines)).not.toContain('expectedHash')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cliRunExitCode, writeHumanRunResult, type HumanRunOutcome } from '../packages/cli/src/commands/human-run-result.ts'

function printed(input: { streamedText: boolean; outcome: HumanRunOutcome; taskOutcome: { status?: string } | null }) {
  const out: string[] = []
  const err: string[] = []
  writeHumanRunResult({ stdout: text => out.push(text), stderr: text => err.push(text) }, input)
  return { stdout: out.join(''), stderr: err.join('') }
}

describe('non-interactive human run result', () => {
  it('is the writer used by both text exits', () => {
    const run = readFileSync(new URL('../packages/cli/src/commands/run.ts', import.meta.url), 'utf8')
    const resume = readFileSync(new URL('../packages/cli/src/commands/resume.ts', import.meta.url), 'utf8')
    expect(run).toContain('writeHumanRunResult')
    expect(resume).toContain('writeHumanRunResult')
    expect(run).toContain('cliRunExitCode')
    expect(resume).toContain('cliRunExitCode')
    expect(run).not.toContain('[${outcome.status}]')
    expect(resume).not.toContain('[${outcome.status}]')
  })

  it('prints the shared task result for streamed, text, empty, failed, and taskless exits', () => {
    expect(printed({ streamedText: true, outcome: { status: 'succeeded', text: '已经流过' }, taskOutcome: { status: 'incomplete' } })).toEqual({ stdout: '\n[任务未完成]\n', stderr: '' })
    expect(printed({ streamedText: false, outcome: { status: 'succeeded', text: '正文' }, taskOutcome: { status: 'accepted' } }).stdout).toBe('正文\n\n[任务验收通过]\n')
    expect(printed({ streamedText: false, outcome: { status: 'succeeded' }, taskOutcome: null }).stdout).toBe('\n[回复完成]\n')
    const failed = printed({ streamedText: false, outcome: { status: 'failed', text: '不重复正文', error: { code: 'TOOL', message: '失败' } }, taskOutcome: { status: 'accepted' } })
    expect(failed.stderr).toBe('\n[错误] TOOL: 失败\n')
    expect(failed.stdout).toBe('\n[任务执行失败 · TOOL]\n')
    expect(failed.stdout).not.toContain('任务验收通过')
    expect(failed.stdout).not.toContain('不重复正文')
  })

  it('keeps the existing exit-code contract', () => {
    expect(cliRunExitCode('cancelled', { status: 'accepted' })).toBe(3)
    expect(cliRunExitCode('succeeded', null)).toBe(0)
    expect(cliRunExitCode('succeeded', { status: 'accepted' })).toBe(0)
    expect(cliRunExitCode('succeeded', { status: 'incomplete' })).toBe(1)
    expect(cliRunExitCode('failed', { status: 'accepted' })).toBe(1)
  })
})

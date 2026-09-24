import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
const execute = promisify(execFile)
const grade = async (workspace: string, task: string) => JSON.parse((await execute(process.execPath, [resolve('scripts/eval/grade.mjs'), '--task', task, '--workspace', workspace])).stdout)

describe('evaluation grader regressions', () => {
  it('accepts plain source URLs and access dates without requiring an arbitrary heading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-grader-'))
    try {
      await mkdir(join(root, 'research'))
      const report = '# Releases\nSource: https://nodejs.org/en/about/previous-releases\nAccess date: 2026-09-24\nVersion | Status\nv26 | Current\nv24 | LTS\n'
      await writeFile(join(root, 'research/node-release-lines.md'), report)
      expect((await grade(root, 'research-01')).passed).toBe(true)
      await writeFile(join(root, 'research/node-release-lines.md'), report.replace('Access date: 2026-09-24', 'Access date: unknown'))
      expect((await grade(root, 'research-01')).checks.find((item: any) => item.type === 'accessDate').passed).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('executes valid Python behavior probes and rejects swallowed unrelated errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-python-grader-'))
    try {
      await mkdir(join(root, 'src'))
      const source = 'import json\ndef load_json(text, default=None):\n    try: return json.loads(text)\n    except json.JSONDecodeError: return default\n'
      await writeFile(join(root, 'src/json_util.py'), source)
      const behavior = (await grade(root, 'code-03')).checks.find((item: any) => item.type === 'behavior')
      expect(behavior.passed, behavior.error).toBe(true)
      await writeFile(join(root, 'src/json_util.py'), source.replace('json.JSONDecodeError', 'Exception'))
      expect((await grade(root, 'code-03')).checks.find((item: any) => item.type === 'behavior').passed).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

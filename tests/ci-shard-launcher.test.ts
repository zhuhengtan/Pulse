import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
it('runs all four real shard entrypoints with exact collection receipts from a tiny installed fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse ci shard '))
  try {
    await mkdir(join(root, 'scripts/ci'), { recursive: true }); await mkdir(join(root, 'tests'))
    await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const name of ['test.mjs', 'test-plan.mjs', 'test-reporter.mjs', 'windows-test-timings.json', 'network-guard.mjs']) await copyFile(join(process.cwd(), 'scripts/ci', name), join(root, 'scripts/ci', name))
    await writeFile(join(root, 'vitest.config.ts'), 'export default {test:{pool:"forks",fileParallelism:false},css:{postcss:{plugins:[]}}}')
    for (let n = 1; n <= 4; n++) await writeFile(join(root, `tests/${n}.test.ts`), `import {it,expect} from 'vitest';it('fixture ${n}',()=>expect(${n}).toBe(${n}))`)
    for (let n = 1; n <= 4; n++) {
      const result = spawnSync(process.execPath, [join(root, 'scripts/ci/test.mjs'), `--shard=${n}`], { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, PULSE_CI_NETWORK_LOG: join(root, 'network.jsonl') } })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('"shard":' + n + ',"files":1,"totalFiles":4')
      expect(result.stdout).toMatch(/\[ci:coverage\].*"files":1,"passed":1,"skipped":0/)
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 90000)

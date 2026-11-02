import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { workflowEnvContextErrors } from '../scripts/ci/workflow-env-contexts.mjs'

it('rejects unavailable pre-runner contexts while retaining step, inline and literal expressions', () => {
  expect(workflowEnvContextErrors('env:\n  CACHE: ${{ runner.temp }}')).toEqual([{ line: 1, scope: 'workflow.env', context: 'runner' }])
  for (const context of ['runner', 'job', 'steps', 'env']) expect(workflowEnvContextErrors(`jobs:\n  test:\n    env: { CACHE: '\${{ ${context}.temp }}' }`)).toEqual([{ line: 3, scope: 'job.env', context }])
  expect(workflowEnvContextErrors(`jobs:\n  test:\n    env:\n      CACHE: \${{ format('runner.temp={0}', github.ref) }}\n    steps:\n      - run: build\n        env:\n          CACHE: \${{ runner.temp }}`)).toEqual([])
})

it('starts the real preflight and places the native Cargo cache at build-step scope in both workflows', async () => {
  const result = spawnSync(process.execPath, ['scripts/ci/workflow-env-contexts.mjs'], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
  for (const name of ['ci', 'desktop']) {
    const source = await readFile(`.github/workflows/${name}.yml`, 'utf8')
    expect(workflowEnvContextErrors(source)).toEqual([])
    const builds = [...source.matchAll(/- run: pnpm desktop:build\r?\n +env:\r?\n +PULSE_DESKTOP_CARGO_TARGET_DIR: \$\{\{ runner\.temp \}\}\/pulse-desktop-cargo/g)]
    expect(builds).toHaveLength(name === 'ci' ? 2 : 1)
  }
})

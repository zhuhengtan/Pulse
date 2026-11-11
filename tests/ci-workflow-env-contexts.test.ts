import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { workflowEnvContextErrors } from '../scripts/ci/workflow-env-contexts.mjs'

it('rejects unavailable pre-runner contexts while retaining step, inline and literal expressions', () => {
  expect(workflowEnvContextErrors('env:\n  CACHE: ${{ runner.temp }}')).toEqual([{ line: 1, scope: 'workflow.env', context: 'runner' }])
  for (const context of ['runner', 'job', 'steps', 'env']) expect(workflowEnvContextErrors(`jobs:\n  test:\n    env: { CACHE: '\${{ ${context}.temp }}' }`)).toEqual([{ line: 3, scope: 'job.env', context }])
  expect(workflowEnvContextErrors(`jobs:\n  test:\n    env:\n      CACHE: \${{ format('runner.temp={0}', github.ref) }}\n    steps:\n      - run: build\n        env:\n          CACHE: \${{ runner.temp }}`)).toEqual([])
})

it('starts the real preflight and builds desktop through the current agent-desktop chain', async () => {
  const result = spawnSync(process.execPath, ['scripts/ci/workflow-env-contexts.mjs'], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
  for (const name of ['ci', 'desktop']) {
    const source = await readFile(`.github/workflows/${name}.yml`, 'utf8')
    expect(workflowEnvContextErrors(source)).toEqual([])
    expect([...source.matchAll(/- run: pnpm desktop:build\b/g)]).toHaveLength(name === 'ci' ? 2 : 1)
    expect(source).not.toContain('PULSE_DESKTOP_CARGO_TARGET_DIR')
  }
  const build = await readFile('scripts/automation/build-desktop.mjs', 'utf8')
  expect(build).toContain("const version = '1.2.0'")
  expect(build).toContain('agent-desktop-v${version}-${target}.tar.gz')
  expect(build).toContain('219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82')
  expect(build).toContain('a4199f741a441cedd349bf56c5eba01783b1261258b498efeb7ec9945220c3e8')
  expect(build).toContain('591ae7f4a38479dc045df97e27447c0c8b530441730ab6b990e27c813162af44')
  expect(build).not.toContain('PULSE_DESKTOP_CARGO_TARGET_DIR')
})

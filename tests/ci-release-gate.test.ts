import { expect, it } from 'vitest'
import { verifyMainCI } from '../scripts/updates/require-ci.mjs'
import { githubJobs, windowsJobs, verifyWindowsJobs } from '../scripts/ci/windows-gate.mjs'
const sha = 'a'.repeat(40)
const run = { head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }
const jobs = [
  ...['ubuntu-24.04', 'macos-15', 'windows-2022'].map(os => ({ name: `check (${os})`, status: 'completed', conclusion: 'success', labels: [os === 'windows-2022' ? 'ubuntu-24.04' : os] })),
  ...windowsJobs.map(name => ({ name, status: 'completed', conclusion: 'success', labels: ['windows-2022'] })),
]
it('requires all native Windows jobs even when the compatibility aggregate is green', () => {
  expect(() => verifyMainCI(run, jobs, sha)).not.toThrow()
  for (const name of windowsJobs) {
    expect(() => verifyMainCI(run, jobs.filter(job => job.name !== name), sha)).toThrow('WINDOWS_CHECK_REQUIRED')
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) expect(() => verifyWindowsJobs(jobs.map(job => job.name === name ? { ...job, conclusion } : job))).toThrow()
    expect(() => verifyWindowsJobs(jobs.map(job => job.name === name ? { ...job, labels: ['ubuntu-24.04'] } : job))).toThrow()
  }
  expect(() => verifyWindowsJobs([...jobs, jobs.at(-1)])).toThrow()
})
it('rejects stale commits, PR/manual runs, incomplete or unsuccessful gates and wrong actual platforms', () => {
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { event: 'pull_request' }, { event: 'workflow_dispatch' }, { status: 'in_progress' }, { conclusion: 'failure' }]) expect(() => verifyMainCI({ ...run, ...patch }, jobs, sha)).toThrow('EXACT_COMMIT_CI_REQUIRED')
  expect(() => verifyMainCI(run, jobs.slice(1), sha)).toThrow('CI_MATRIX_REQUIRED')
  expect(() => verifyMainCI(run, jobs.map((job, i) => i === 0 ? { ...job, labels: ['macos-15'] } : job), sha)).toThrow('CI_PLATFORM_REQUIRED')
})
it('paginates only the latest job attempts without silently dropping later jobs', async () => {
  const paths: string[] = []
  const actual = await githubJobs(123, async path => { paths.push(path); return { jobs: paths.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }] } })
  expect(actual).toHaveLength(101)
  expect(paths).toEqual(['runs/123/jobs?filter=latest&per_page=100&page=1', 'runs/123/jobs?filter=latest&per_page=100&page=2'])
})

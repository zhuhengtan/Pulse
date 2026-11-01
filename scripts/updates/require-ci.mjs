import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { githubGet, githubJobs, verifyWindowsJobs } from '../ci/windows-gate.mjs'
export function verifyMainCI(run, jobs, sha) {
  if (run?.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push' || run.status !== 'completed' || run.conclusion !== 'success') throw Error('EXACT_COMMIT_CI_REQUIRED')
  for (const os of ['ubuntu-24.04', 'macos-15', 'windows-2022']) {
    const matches = jobs.filter(job => job.name === `check (${os})`)
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') throw Error('CI_MATRIX_REQUIRED:' + os)
    if (os !== 'windows-2022' && !matches[0].labels?.includes(os)) throw Error('CI_PLATFORM_REQUIRED:' + os)
  }
  verifyWindowsJobs(jobs)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const { workflow_runs: runs } = await githubGet(`workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`)
  const run = runs.filter(item => item.head_branch === 'main' && item.head_sha === sha).sort((a, b) => b.id - a.id)[0]
  if (!run) throw Error('EXACT_COMMIT_CI_REQUIRED')
  verifyMainCI(run, await githubJobs(run.id), sha)
  console.log(`Exact commit ${sha} passed all platforms and every native Windows shard.`)
}

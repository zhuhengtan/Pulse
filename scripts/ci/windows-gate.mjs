import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const windowsJobs = ['windows-common', 'windows-tests-1', 'windows-tests-2', 'windows-tests-3', 'windows-tests-4']
export function verifyWindowsJobs(jobs) {
  for (const name of windowsJobs) {
    const matches = jobs.filter(job => job.name === name)
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success' || !matches[0].labels?.includes('windows-2022')) throw Error('WINDOWS_CHECK_REQUIRED:' + name)
  }
}
export async function githubGet(path) {
  const response = await fetch('https://api.github.com/repos/zhuhengtan/Pulse/actions/' + path, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw Error('CI_METADATA_UNAVAILABLE:' + response.status)
  return response.json()
}
export async function githubJobs(id, get = githubGet) {
  const jobs = []
  for (let page = 1; ; page++) { const value = await get(`runs/${id}/jobs?filter=latest&per_page=100&page=${page}`); jobs.push(...value.jobs); if (value.jobs.length < 100) return jobs }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '')) throw Error('CI_RUN_ID_REQUIRED')
  verifyWindowsJobs(await githubJobs(process.env.GITHUB_RUN_ID))
  console.log('All five native Windows checks completed successfully, including all four backend shards.')
}

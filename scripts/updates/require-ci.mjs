import { execFileSync } from 'node:child_process';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN}` };
const api = 'https://api.github.com/repos/zhuhengtan/Pulse/actions';
async function get(url) { const response = await fetch(url, { headers }); if (!response.ok) throw new Error(`CI_METADATA_UNAVAILABLE:${response.status}`); return response.json(); }
const { workflow_runs: runs } = await get(`${api}/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`);
const run = runs.filter(item => item.head_branch === 'main' && item.head_sha === sha).sort((a, b) => b.id - a.id)[0];
if (run?.status !== 'completed' || run.conclusion !== 'success') throw new Error('EXACT_COMMIT_CI_REQUIRED');
const jobs = [];
for (let page = 1; ; page++) { const value = await get(`${api}/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`); jobs.push(...value.jobs); if (value.jobs.length < 100) break; }
for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) if (!jobs.some(item => item.name === `check (${os})` && item.status === 'completed' && item.conclusion === 'success')) throw new Error(`CI_MATRIX_REQUIRED:${os}`);
console.log(`Exact commit ${sha} passed all required CI platforms.`);

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const stage = await mkdtemp(join(tmpdir(), 'pulse-npm-release-'))
const order = ['runtime', 'tool-sdk', 'adapters', 'server', 'cli']
const manifests = new Map()
for (const name of order) manifests.set(name, JSON.parse(await readFile(join(repo, `packages/${name}/package.json`), 'utf8')))
const versions = new Map([...manifests.values()].map((data) => [data.name, data.version]))
try {
  for (const name of order) {
    const source = join(repo, `packages/${name}`); const target = join(stage, name)
    await mkdir(target, { recursive: true }); await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true })
    await cp(join(source, 'README.md'), join(target, 'README.md'))
    if (name === 'cli') await cp(join(source, 'scripts'), join(target, 'scripts'), { recursive: true })
    const data = structuredClone(manifests.get(name))
    for (const dependencies of [data.dependencies, data.optionalDependencies, data.peerDependencies]) for (const [dependency, value] of Object.entries(dependencies ?? {})) if (value === 'workspace:*' && versions.has(dependency)) dependencies[dependency] = versions.get(dependency)
    await writeFile(join(target, 'package.json'), `${JSON.stringify(data, null, 2)}\n`)
    const args = ['publish', target, '--access', 'public', '--ignore-scripts']
    if (process.env.NPM_DRY_RUN === '1') args.push('--dry-run')
    if (process.env.NPM_PROVENANCE === '1') args.push('--provenance')
    const result = spawnSync('npm', args, { stdio: 'inherit', env: process.env })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
} finally { await rm(stage, { recursive: true, force: true }) }

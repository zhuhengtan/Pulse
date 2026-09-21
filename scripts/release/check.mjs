import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const packageNames = ['runtime', 'tool-sdk', 'adapters', 'server', 'cli']
const manifests = await Promise.all(packageNames.map(async (name) => ({ name, data: JSON.parse(await readFile(join(repo, `packages/${name}/package.json`), 'utf8')) })))
const versions = new Set(manifests.map(({ data }) => data.version))
if (versions.size !== 1) throw new Error(`RELEASE_VERSION_MISMATCH:${[...versions].join(',')}`)
for (const { name, data } of manifests) {
  if (!data.publishConfig || data.publishConfig.access !== 'public') throw new Error(`RELEASE_PUBLIC_CONFIG_MISSING:${name}`)
  if (name !== 'cli' && !(await readFile(join(repo, `packages/${name}/dist/index.js`)).catch(() => undefined))) throw new Error(`RELEASE_BUILD_MISSING:${name}`)
  if (name === 'cli' && !(await readFile(join(repo, 'packages/cli/dist/bin.js')).catch(() => undefined))) throw new Error('RELEASE_BUILD_MISSING:cli')
}
console.log(`Release check passed for ${[...versions][0]} (${packageNames.length} packages).`)
